// ============================================================
//  QW电竞 - 后端 API（Cloudflare Pages Functions）
//  数据库：MongoDB Atlas
// ============================================================

const MONGODB_URI = 'mongodb+srv://mffttttt0705_db_user:LZQ704525@cluster0.lpunuuy.mongodb.net/?appName=Cluster0';

import { MongoClient } from 'mongodb';

let cachedClient = null;

async function getMongoClient() {
  if (cachedClient) return cachedClient;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client;
}

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

async function handleRegister(db, body) {
  const { username, password, role } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');
  const users = db.collection('users');
  const existing = await users.findOne({ username });
  if (existing) return errorResponse('用户名已存在');
  const result = await users.insertOne({
    username, password, role: role || 'boss',
    diamond: 0, balance: 0, status: 'active', createdAt: new Date()
  });
  return jsonResponse({ message: '注册成功', id: result.insertedId.toString() });
}

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

async function handleGetProducts(db) {
  const products = db.collection('products');
  const list = await products.find({ hidden: false }).sort({ createTime: -1 }).toArray();
  return jsonResponse(list);
}

async function handleGetAnnounce(db) {
  const announces = db.collection('announces');
  const data = await announces.findOne({}, { sort: { updatedAt: -1 } });
  return jsonResponse(data || { content: '欢迎使用 QW电竞护航平台！' });
}

async function handleGetMe(db, userId) {
  const users = db.collection('users');
  const user = await users.findOne({ _id: userId });
  if (!user) return errorResponse('用户不存在', 404);
  const { password, ...rest } = user;
  return jsonResponse(rest);
}

async function handleGetMyOrders(db, userId, userRole) {
  const orders = db.collection('orders');
  let query = {};
  if (userRole === 'boss') query.bossId = userId;
  else if (userRole === 'handler') query.handlerId = userId;
  else return errorResponse('无权查看', 403);
  const list = await orders.find(query).sort({ createTime: -1 }).toArray();
  return jsonResponse(list);
}

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
  const result = await orders.insertOne(order);
  await products.updateOne({ _id: productId }, { $inc: { sold: 1 } });
  return jsonResponse({ orderId: result.insertedId.toString(), message: '购买成功' });
}

// ============================================================
//  主入口
// ============================================================

export async function onRequest(context) {
  const request = context.request;
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

    // 公开接口
    if (path === '/api/login' && method === 'POST') return await handleLogin(db, body);
    if (path === '/api/register' && method === 'POST') return await handleRegister(db, body);
    if (path === '/api/products' && method === 'GET') return await handleGetProducts(db);
    if (path === '/api/announce' && method === 'GET') return await handleGetAnnounce(db);

    // 验证 Token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return errorResponse('请先登录', 401);
    const parts = authHeader.split('.');
    if (parts.length !== 2) return errorResponse('无效token', 401);
    const userId = parts[1];

    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return errorResponse('用户不存在', 401);

    // 需要登录的接口
    if (path === '/api/me' && method === 'GET') return await handleGetMe(db, userId);
    if (path === '/api/orders/my' && method === 'GET') return await handleGetMyOrders(db, userId, user.role);
    if (path === '/api/orders/buy' && method === 'POST') return await handleBuyProduct(db, userId, body);

    // ===== 管理员接口 =====
    if (user.role === 'admin') {
      if (path === '/api/admin/orders' && method === 'GET') {
        const orders = db.collection('orders');
        return jsonResponse(await orders.find().sort({ createTime: -1 }).toArray());
      }
      if (path === '/api/admin/users' && method === 'GET') {
        const usersCol = db.collection('users');
        const list = await usersCol.find().toArray();
        return jsonResponse(list.map(u => { const { password, ...rest } = u; return rest; }));
      }
      if (path === '/api/admin/products' && method === 'GET') {
        const products = db.collection('products');
        return jsonResponse(await products.find().sort({ createTime: -1 }).toArray());
      }
      if (path === '/api/admin/products' && method === 'POST') {
        const { game, title, desc, price, quantity } = body;
        if (!title || !price) return errorResponse('请填写完整信息');
        const products = db.collection('products');
        const result = await products.insertOne({
          game: game || '暗区突围', title, desc: desc || '',
          price: parseFloat(price), quantity: parseInt(quantity) || 1,
          sold: 0, hidden: false, createTime: new Date()
        });
        return jsonResponse({ success: true, id: result.insertedId.toString() });
      }
      if (path === '/api/admin/orders/direct' && method === 'POST') {
        const { game, title, desc, price } = body;
        if (!title || !price) return errorResponse('请填写完整信息');
        const orders = db.collection('orders');
        const result = await orders.insertOne({
          productId: null, bossId: userId, handlerId: null, status: 'pending',
          price: parseFloat(price), game: game || '暗区突围', title, desc: desc || '',
          createTime: new Date(),
          messages: [{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date() }],
          settled: false, settledAmount: 0
        });
        return jsonResponse({ success: true, orderId: result.insertedId.toString() });
      }
    }

    return errorResponse('接口不存在', 404);

  } catch (err) {
    console.error('Error:', err);
    return errorResponse(err.message || '服务器错误', 500);
  }
}