// ============================================================
//  QW电竞 - 后端 API（Cloudflare Worker 版）
//  使用 MongoDB 原生驱动
// ============================================================

// ===== 读取环境变量 =====
// ⚠️ 已在 Worker 设置中添加了 MONGODB_URI 环境变量
const MONGODB_URI = env.MONGODB_URI || 'mongodb+srv://mffttttt0705_db_user:LZQ704525@cluster0.lpunuuy.mongodb.net/?appName=Cluster0';

// ===== 引入 MongoDB 驱动 =====
import { MongoClient } from 'mongodb';

let cachedClient = null;

async function getMongoClient() {
  if (cachedClient) return cachedClient;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client;
}

// ============================================================
//  工具函数
// ============================================================
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// ============================================================
//  业务函数
// ============================================================

// 注册
async function handleRegister(db, body) {
  const { username, password, role } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const users = db.collection('users');
  const existing = await users.findOne({ username });
  if (existing) return errorResponse('用户名已存在');

  await users.insertOne({
    username, password, role: role || 'boss',
    diamond: 0, balance: 0, status: 'active', createdAt: new Date()
  });
  return jsonResponse({ message: '注册成功' });
}

// 登录
async function handleLogin(db, body) {
  const { username, password } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const users = db.collection('users');
  const user = await users.findOne({ username });
  if (!user) return errorResponse('用户不存在');
  if (user.password !== password) return errorResponse('密码错误');

  const token = generateId() + '.' + user._id.toString();
  return jsonResponse({
    token,
    user: {
      id: user._id.toString(),
      username: user.username,
      role: user.role || 'boss',
      diamond: user.diamond || 0,
      balance: user.balance || 0,
      status: user.status || 'active'
    }
  });
}

// 获取商品
async function handleGetProducts(db) {
  const products = db.collection('products');
  const list = await products.find({ hidden: false }).sort({ createTime: -1 }).toArray();
  return jsonResponse(list);
}

// 获取公告
async function handleGetAnnounce(db) {
  const announces = db.collection('announces');
  const data = await announces.findOne({}, { sort: { updatedAt: -1 } });
  return jsonResponse(data || { content: '欢迎使用 QW电竞护航平台！' });
}

// 获取个人信息
async function handleGetMe(db, userId) {
  const users = db.collection('users');
  const user = await users.findOne({ _id: userId });
  if (!user) return errorResponse('用户不存在', 404);
  const { password, ...rest } = user;
  return jsonResponse(rest);
}

// 获取我的订单
async function handleGetMyOrders(db, userId, userRole) {
  const orders = db.collection('orders');
  let query = {};
  if (userRole === 'boss') query.bossId = userId;
  else if (userRole === 'handler') query.handlerId = userId;
  else return errorResponse('无权查看', 403);
  const list = await orders.find(query).sort({ createTime: -1 }).toArray();
  return jsonResponse(list);
}

// 购买商品
async function handleBuyProduct(db, userId, body) {
  const { productId } = body;
  if (!productId) return errorResponse('请选择商品');

  const products = db.collection('products');
  const product = await products.findOne({ _id: productId });
  if (!product) return errorResponse('商品不存在', 404);
  if (product.quantity <= product.sold) return errorResponse('库存不足');

  const users = db.collection('users');
  const user = await users.findOne({ _id: userId });
  const diamondCost = product.price * 10;
  if (user.diamond < diamondCost) return errorResponse('红钻不足');

  await users.updateOne({ _id: userId }, { $inc: { diamond: -diamondCost } });

  const orders = db.collection('orders');
  const order = {
    productId: product._id, bossId: userId, handlerId: null,
    status: 'pending', price: product.price, game: product.game,
    title: product.title, desc: product.desc || '',
    createTime: new Date(),
    messages: [{ sender: 'system', content: '🎉 订单已创建', time: new Date() }],
    settled: false, settledAmount: 0
  };
  await orders.insertOne(order);
  await products.updateOne({ _id: productId }, { $inc: { sold: 1 } });

  return jsonResponse({ message: '购买成功' });
}

// 打手接单
async function handleTakeOrder(db, userId, userRole, orderId) {
  if (userRole !== 'handler') return errorResponse('只有打手可接单');
  const orders = db.collection('orders');
  const order = await orders.findOne({ _id: orderId });
  if (!order) return errorResponse('订单不存在', 404);
  if (order.status !== 'pending') return errorResponse('订单不可接');
  await orders.updateOne({ _id: orderId }, {
    $set: { handlerId: userId, status: 'ongoing', startTime: new Date() }
  });
  return jsonResponse({ message: '接单成功' });
}

// 打手提交完成
async function handleSubmitComplete(db, userId, userRole, orderId) {
  if (userRole !== 'handler') return errorResponse('只有打手可操作');
  const orders = db.collection('orders');
  const order = await orders.findOne({ _id: orderId });
  if (!order) return errorResponse('订单不存在', 404);
  if (order.handlerId !== userId) return errorResponse('不是你的订单', 403);
  if (order.status !== 'ongoing') return errorResponse('只有进行中可提交');
  await orders.updateOne({ _id: orderId }, { $set: { status: 'review' } });
  return jsonResponse({ message: '已提交验收' });
}

// 老板确认完成
async function handleBossConfirm(db, userId, userRole, orderId) {
  if (userRole !== 'boss') return errorResponse('只有老板可操作');
  const orders = db.collection('orders');
  const order = await orders.findOne({ _id: orderId });
  if (!order) return errorResponse('订单不存在', 404);
  if (order.bossId !== userId) return errorResponse('不是你的订单', 403);
  if (order.status !== 'review') return errorResponse('只有待验收可确认');
  await orders.updateOne({ _id: orderId }, {
    $set: { status: 'completed', endTime: new Date() }
  });
  return jsonResponse({ message: '已确认完成，等待管理员结算' });
}

// 申请退款
async function handleRefundRequest(db, userId, userRole, orderId, body) {
  if (userRole !== 'boss') return errorResponse('只有老板可发起退款');
  const { reason } = body;
  if (!reason) return errorResponse('请填写退款原因');
  const orders = db.collection('orders');
  const order = await orders.findOne({ _id: orderId });
  if (!order) return errorResponse('订单不存在', 404);
  if (order.bossId !== userId) return errorResponse('不是你的订单', 403);
  if (order.status === 'completed') return errorResponse('已完成订单不可退款');
  if (order.status === 'refunded' || order.status === 'refund_pending') {
    return errorResponse('已处理退款');
  }
  await orders.updateOne({ _id: orderId }, {
    $set: { status: 'refund_pending', refundReason: reason }
  });
  return jsonResponse({ success: true, message: '退款申请已提交' });
}

// ============================================================
//  管理员函数
// ============================================================
async function handleAdminOrders(db) {
  const orders = db.collection('orders');
  const list = await orders.find().sort({ createTime: -1 }).toArray();
  return jsonResponse(list);
}

async function handleAdminUsers(db) {
  const users = db.collection('users');
  const list = await users.find().toArray();
  const cleaned = list.map(u => {
    const { password, ...rest } = u;
    return rest;
  });
  return jsonResponse(cleaned);
}

async function handleAdminProducts(db) {
  const products = db.collection('products');
  const list = await products.find().sort({ createTime: -1 }).toArray();
  return jsonResponse(list);
}

async function handleAdminCreateProduct(db, body) {
  const { game, title, desc, price, quantity } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const products = db.collection('products');
  await products.insertOne({
    game: game || '暗区突围', title, desc: desc || '',
    price: parseFloat(price), quantity: parseInt(quantity) || 1,
    sold: 0, hidden: false, createTime: new Date()
  });
  return jsonResponse({ success: true });
}

async function handleAdminUnshelf(db, productId) {
  const products = db.collection('products');
  await products.updateOne({ _id: productId }, { $set: { hidden: true } });
  return jsonResponse({ success: true, message: '已下架' });
}

async function handleAdminReshelf(db, productId) {
  const products = db.collection('products');
  await products.updateOne({ _id: productId }, { $set: { hidden: false } });
  return jsonResponse({ success: true, message: '已重新上架' });
}

async function handleAdminAssign(db, orderId, body) {
  const { handlerId } = body;
  if (!handlerId) return errorResponse('请选择打手');
  const orders = db.collection('orders');
  await orders.updateOne({ _id: orderId }, {
    $set: { handlerId, status: 'ongoing', startTime: new Date() }
  });
  return jsonResponse({ message: '指派成功' });
}

async function handleAdminForceComplete(db, orderId) {
  const orders = db.collection('orders');
  await orders.updateOne({ _id: orderId }, {
    $set: { status: 'completed', endTime: new Date() }
  });
  return jsonResponse({ message: '强制完成成功' });
}

async function handleAdminConfirm(db, orderId) {
  const orders = db.collection('orders');
  await orders.updateOne({ _id: orderId }, {
    $set: { status: 'completed', endTime: new Date() }
  });
  return jsonResponse({ message: '验收通过' });
}

async function handleAdminCancel(db, orderId) {
  const orders = db.collection('orders');
  const order = await orders.findOne({ _id: orderId });
  await orders.updateOne({ _id: orderId }, { $set: { status: 'canceled' } });
  if (order && order.bossId) {
    const users = db.collection('users');
    await users.updateOne({ _id: order.bossId }, { $inc: { diamond: order.price * 10 } });
  }
  return jsonResponse({ message: '已取消' });
}

async function handleAdminDirectPublish(db, userId, body) {
  const { game, title, desc, price } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const orders = db.collection('orders');
  await orders.insertOne({
    productId: null, bossId: userId, handlerId: null,
    status: 'pending', price: parseFloat(price),
    game: game || '暗区突围', title, desc: desc || '',
    createTime: new Date(),
    messages: [{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date() }],
    settled: false, settledAmount: 0
  });
  return jsonResponse({ success: true });
}

// ============================================================
//  主入口
// ============================================================
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    let body = {};
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch (e) {}

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    try {
      const client = await getMongoClient();
      const db = client.db('qw-esports');

      // ===== 公开接口 =====
      if (path === '/api/login' && method === 'POST') return await handleLogin(db, body);
      if (path === '/api/register' && method === 'POST') return await handleRegister(db, body);
      if (path === '/api/products' && method === 'GET') return await handleGetProducts(db);
      if (path === '/api/announce' && method === 'GET') return await handleGetAnnounce(db);

      // ===== 验证 Token =====
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return errorResponse('请先登录', 401);
      const parts = authHeader.split('.');
      if (parts.length !== 2) return errorResponse('无效token', 401);
      const userId = parts[1];

      const users = db.collection('users');
      const user = await users.findOne({ _id: userId });
      if (!user) return errorResponse('用户不存在', 401);

      // ===== 需要登录的接口 =====
      if (path === '/api/me' && method === 'GET') return await handleGetMe(db, userId);
      if (path === '/api/orders/my' && method === 'GET') return await handleGetMyOrders(db, userId, user.role);
      if (path === '/api/orders/buy' && method === 'POST') return await handleBuyProduct(db, userId, body);

      // ===== 带参数的路由 =====
      if (path.startsWith('/api/orders/')) {
        const orderId = path.replace('/api/orders/', '');
        if (orderId.endsWith('/take')) {
          const id = orderId.replace('/take', '');
          return await handleTakeOrder(db, userId, user.role, id);
        }
        if (orderId.endsWith('/submit-complete')) {
          const id = orderId.replace('/submit-complete', '');
          return await handleSubmitComplete(db, userId, user.role, id);
        }
        if (orderId.endsWith('/boss-confirm')) {
          const id = orderId.replace('/boss-confirm', '');
          return await handleBossConfirm(db, userId, user.role, id);
        }
        if (orderId.endsWith('/refund-request')) {
          const id = orderId.replace('/refund-request', '');
          return await handleRefundRequest(db, userId, user.role, id, body);
        }
      }

      // ===== 管理员接口 =====
      if (user.role === 'admin') {
        if (path === '/api/admin/orders' && method === 'GET') return await handleAdminOrders(db);
        if (path === '/api/admin/users' && method === 'GET') return await handleAdminUsers(db);
        if (path === '/api/admin/products' && method === 'GET') return await handleAdminProducts(db);
        if (path === '/api/admin/products' && method === 'POST') return await handleAdminCreateProduct(db, body);
        if (path === '/api/admin/orders/direct' && method === 'POST') return await handleAdminDirectPublish(db, userId, body);

        // 管理员带参数路由
        if (path.startsWith('/api/admin/')) {
          const adminPath = path.replace('/api/admin/', '');
          if (adminPath.startsWith('products/') && adminPath.endsWith('/unshelf')) {
            const productId = adminPath.replace('products/', '').replace('/unshelf', '');
            return await handleAdminUnshelf(db, productId);
          }
          if (adminPath.startsWith('products/') && adminPath.endsWith('/reshelf')) {
            const productId = adminPath.replace('products/', '').replace('/reshelf', '');
            return await handleAdminReshelf(db, productId);
          }
          if (adminPath.startsWith('orders/') && adminPath.endsWith('/assign')) {
            const orderId = adminPath.replace('orders/', '').replace('/assign', '');
            return await handleAdminAssign(db, orderId, body);
          }
          if (adminPath.startsWith('orders/') && adminPath.endsWith('/force-complete')) {
            const orderId = adminPath.replace('orders/', '').replace('/force-complete', '');
            return await handleAdminForceComplete(db, orderId);
          }
          if (adminPath.startsWith('orders/') && adminPath.endsWith('/confirm')) {
            const orderId = adminPath.replace('orders/', '').replace('/confirm', '');
            return await handleAdminConfirm(db, orderId);
          }
          if (adminPath.startsWith('orders/') && adminPath.endsWith('/cancel')) {
            const orderId = adminPath.replace('orders/', '').replace('/cancel', '');
            return await handleAdminCancel(db, orderId);
          }
        }
      }

      return errorResponse('接口不存在', 404);

    } catch (err) {
      console.error('Error:', err);
      return errorResponse(err.message || '服务器错误', 500);
    }
  }
};