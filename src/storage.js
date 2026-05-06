import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
const dbPath = path.join(dataDir, 'db.json');
const backupsDir = path.join(dataDir, 'backups');

const emptyDb = {
  orders: [],
  withdrawals: [],
  subscriptions: [],
  coupons: {},
  settings: {},
  plans: {
    vip_7d: {
      id: 'vip_7d',
      name: 'VIP 7 dias',
      price: 5.99,
      durationDays: 7,
      description: 'Assinatura VIP por 7 dias',
      roleId: ''
    },
    vip_30d: {
      id: 'vip_30d',
      name: 'VIP 30 dias',
      price: 15.99,
      durationDays: 30,
      description: 'Assinatura VIP por 30 dias',
      roleId: ''
    },
    vip_lifetime: {
      id: 'vip_lifetime',
      name: 'VIP vitalício',
      price: 49.99,
      durationDays: 36500,
      description: 'Assinatura VIP vitalícia',
      roleId: ''
    }
  }
};

async function ensureDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(emptyDb, null, 2));
  }
}

async function backupDbIfNeeded() {
  try {
    if (!fsSync.existsSync(dbPath)) return;
    await fs.mkdir(backupsDir, { recursive: true });

    const files = await fs.readdir(backupsDir).catch(() => []);
    const latest = files
      .filter((file) => file.startsWith('db-') && file.endsWith('.json'))
      .sort()
      .at(-1);

    if (latest) {
      const stat = await fs.stat(path.join(backupsDir, latest));
      const minutesSinceLastBackup = (Date.now() - stat.mtimeMs) / 60000;
      if (minutesSinceLastBackup < 60) return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(dbPath, path.join(backupsDir, `db-${stamp}.json`));
  } catch (error) {
    console.error('Aviso: não consegui criar backup do db.json:', error.message);
  }
}

function normalizeDb(db) {
  return {
    ...emptyDb,
    ...db,
    orders: Array.isArray(db.orders) ? db.orders : [],
    withdrawals: Array.isArray(db.withdrawals) ? db.withdrawals : [],
    subscriptions: Array.isArray(db.subscriptions) ? db.subscriptions : [],
    coupons: db.coupons && typeof db.coupons === 'object' && !Array.isArray(db.coupons) ? db.coupons : {},
    settings: db.settings && typeof db.settings === 'object' ? db.settings : {},
    plans: db.plans && typeof db.plans === 'object' ? db.plans : { ...emptyDb.plans }
  };
}

export async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(dbPath, 'utf8');
  return normalizeDb(JSON.parse(raw || JSON.stringify(emptyDb)));
}

export async function writeDb(db) {
  await ensureDb();
  await backupDbIfNeeded();
  await fs.writeFile(dbPath, JSON.stringify(normalizeDb(db), null, 2));
}

export async function addOrder(order) {
  const db = await readDb();
  db.orders.push(order);
  await writeDb(db);
  return order;
}

export async function updateOrder(orderId, patch) {
  const db = await readDb();
  const index = db.orders.findIndex((o) => o.id === orderId || String(o.paymentId) === String(orderId));
  if (index === -1) return null;
  db.orders[index] = { ...db.orders[index], ...patch, updatedAt: new Date().toISOString() };
  await writeDb(db);
  return db.orders[index];
}

export async function findOrderByPaymentId(paymentId) {
  const db = await readDb();
  return db.orders.find((o) => String(o.paymentId) === String(paymentId));
}

export async function getPendingOrders() {
  const db = await readDb();
  return db.orders.filter((o) => ['pending', 'in_process'].includes(o.status));
}

export async function getPendingOrderByUser(userId) {
  const db = await readDb();
  return db.orders.find((o) => o.userId === userId && ['pending', 'in_process'].includes(o.status)) || null;
}

export async function upsertSubscription(subscription) {
  const db = await readDb();
  const existing = db.subscriptions.findIndex((s) => s.userId === subscription.userId);
  if (existing >= 0) {
    db.subscriptions[existing] = { ...db.subscriptions[existing], ...subscription, updatedAt: new Date().toISOString() };
  } else {
    db.subscriptions.push({ ...subscription, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  await writeDb(db);
  return subscription;
}

export async function updateSubscription(userId, patch) {
  const db = await readDb();
  const index = db.subscriptions.findIndex((s) => s.userId === userId);
  if (index === -1) return null;
  db.subscriptions[index] = { ...db.subscriptions[index], ...patch, updatedAt: new Date().toISOString() };
  await writeDb(db);
  return db.subscriptions[index];
}

export async function getSubscription(userId) {
  const db = await readDb();
  return db.subscriptions.find((s) => s.userId === userId) || null;
}

export async function getActiveSubscriptions() {
  const db = await readDb();
  return db.subscriptions.filter((s) => s.active);
}

export async function deactivateSubscription(userId) {
  const db = await readDb();
  const index = db.subscriptions.findIndex((s) => s.userId === userId);
  if (index === -1) return null;
  db.subscriptions[index] = { ...db.subscriptions[index], active: false, updatedAt: new Date().toISOString() };
  await writeDb(db);
  return db.subscriptions[index];
}

export async function getSettings() {
  const db = await readDb();
  return db.settings || {};
}

export async function updateSettings(settings) {
  const db = await readDb();
  db.settings = { ...db.settings, ...settings };
  await writeDb(db);
  return db.settings;
}

export async function updatePlan(planId, planData) {
  const db = await readDb();
  db.plans[planId] = { ...(db.plans[planId] || { id: planId }), ...planData, id: planId };
  await writeDb(db);
  return db.plans[planId];
}

export async function deletePlan(planId) {
  const db = await readDb();
  if (!db.plans[planId]) return false;
  delete db.plans[planId];
  await writeDb(db);
  return true;
}


export async function addWithdrawal(withdrawal) {
  const db = await readDb();
  const value = Number(withdrawal.amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Valor de retirada inválido.');
  }

  const item = {
    id: withdrawal.id || `retirada_${Date.now()}`,
    amount: value,
    adminId: withdrawal.adminId || null,
    reason: withdrawal.reason || 'Sem motivo informado',
    createdAt: withdrawal.createdAt || new Date().toISOString()
  };

  db.withdrawals.push(item);
  await writeDb(db);
  return item;
}

export async function getFinancialSummary() {
  const db = await readDb();
  const approvedOrders = db.orders.filter((order) => order.status === 'approved');
  const pendingOrders = db.orders.filter((order) => ['pending', 'in_process'].includes(order.status));

  const grossSales = approvedOrders.reduce((total, order) => total + Number(order.amount || 0), 0);
  const pendingSales = pendingOrders.reduce((total, order) => total + Number(order.amount || 0), 0);
  const totalWithdrawn = db.withdrawals.reduce((total, item) => total + Number(item.amount || 0), 0);

  return {
    grossSales,
    totalWithdrawn,
    availableBalance: grossSales - totalWithdrawn,
    approvedCount: approvedOrders.length,
    pendingSales,
    pendingCount: pendingOrders.length,
    withdrawals: db.withdrawals.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  };
}


export async function getAllSubscriptions() {
  const db = await readDb();
  return db.subscriptions.slice().sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

export async function getUserOrders(userId) {
  const db = await readDb();
  return db.orders.filter((o) => String(o.userId) === String(userId)).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export async function getCoupons() {
  const db = await readDb();
  return db.coupons || {};
}

export async function upsertCoupon(name, couponData) {
  const db = await readDb();
  const key = String(name || '').trim().toUpperCase();
  if (!key) throw new Error('Nome do cupom inválido.');
  const previous = db.coupons?.[key] || {};
  db.coupons[key] = {
    name: key,
    discountPercent: Number(couponData.discountPercent || 0),
    maxUses: couponData.maxUses === null || couponData.maxUses === undefined ? null : Number(couponData.maxUses),
    uses: Number(couponData.uses ?? previous.uses ?? 0),
    active: couponData.active ?? true,
    createdBy: couponData.createdBy || previous.createdBy || null,
    createdAt: couponData.createdAt || previous.createdAt || new Date().toISOString()
  };
  await writeDb(db);
  return db.coupons[key];
}

export async function deleteCoupon(name) {
  const db = await readDb();
  const key = String(name || '').trim().toUpperCase();
  if (!db.coupons?.[key]) return false;
  delete db.coupons[key];
  await writeDb(db);
  return true;
}

export async function useCoupon(name) {
  const db = await readDb();
  const key = String(name || '').trim().toUpperCase();
  const coupon = db.coupons?.[key];
  if (!coupon || !coupon.active) return { ok: false, reason: 'Cupom não encontrado ou inativo.' };
  if (coupon.maxUses !== null && coupon.maxUses !== undefined && Number(coupon.uses || 0) >= Number(coupon.maxUses)) {
    return { ok: false, reason: 'Cupom esgotado.' };
  }
  coupon.uses = Number(coupon.uses || 0) + 1;
  db.coupons[key] = coupon;
  await writeDb(db);
  return { ok: true, coupon };
}

export async function buildReportData() {
  const db = await readDb();
  return {
    orders: db.orders || [],
    withdrawals: db.withdrawals || [],
    subscriptions: db.subscriptions || [],
    coupons: db.coupons || {},
    settings: db.settings || {},
    plans: db.plans || {}
  };
}
