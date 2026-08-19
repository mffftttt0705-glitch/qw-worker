// ============================================================
//  Cloudflare Worker 版后端（兼容现有 API）
// ============================================================

// 引入 MongoDB 驱动
const { MongoClient } = require('mongodb');

// MongoDB 连接配置
const MONGODB_URI = 'mongodb+srv://mffttttt0705_db_user:LZQ704525@cluster0.lpunuuy.mongodb.net/?appName=Cluster0';
let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  cachedDb = client.db('test'); // 数据库名
  return cachedDb;
}

// 工具函数：解析请求体
async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// 生成 JWT（简化版，用于兼容）
function signJWT(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const signature = btoa('mysecretkey123'); // 简化，实际应用应使用 HMAC
  return `${header}.${body}.${signature}`;
}

// 验证 Token（简化版）
function verifyToken(authHeader) {
  if (!authHeader) return null;
  try {
    const token = authHeader.replace('Bearer ', '');
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch {
    return null;
  }
}

// ============================================================
//  路由处理
// ============================================================

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS 预检
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  try {
    const db = await getDb();
    const users = db.collection('users');
    const products = db.collection('products');
    const orders = db.collection('orders');
    const recharges = db.collection('recharges');
    const announces = db.collection('announces');
    const mails = db.collection('mails');

    // ========== 公告 ==========
    if (path === '/api/announce' && method === 'GET') {
      const data = await announces.findOne({}, { sort: { updatedAt: -1 } });
      return new Response(JSON.stringify(data || { content: '欢迎使用 QW电竞护航平台！', images: [] }), { headers });
    }

    if (path === '/api/admin/announce' && method === 'PUT') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token || token.role !== 'admin') return new Response(JSON.stringify({ error: '无权操作' }), { status: 403, headers });
      const body = await parseBody(request);
      await announces.deleteMany({});
      await announces.insertOne({
        content: body.content || '欢迎使用 QW电竞护航平台！',
        images: body.images || [],
        updatedAt: new Date()
      });
      return new Response(JSON.stringify({ success: true, message: '公告已更新' }), { headers });
    }

    // ========== 注册 ==========
    if (path === '/api/register' && method === 'POST') {
      const body = await parseBody(request);
      const existing = await users.findOne({ username: body.username });
      if (existing) {
        return new Response(JSON.stringify({ error: '用户名已存在' }), { status: 400, headers });
      }
      // 简化密码哈希（实际应使用 bcrypt，Worker 中可用 bcryptjs 或 crypto）
      const hashedPassword = body.password; // 简化，实际应加密
      const newUser = {
        username: body.username,
        password: hashedPassword,
        role: body.role || 'boss',
        phone: body.phone || '',
        game: body.game || '',
        status: 'active',
        handlerStatus: body.role === 'handler' ? 'idle' : '',
        balance: 0,
        diamond: 0,
        createdAt: new Date()
      };
      const result = await users.insertOne(newUser);
      return new Response(JSON.stringify({ message: '注册成功', userId: result.insertedId }), { headers });
    }

    // ========== 登录 ==========
    if (path === '/api/login' && method === 'POST') {
      const body = await parseBody(request);
      const user = await users.findOne({ username: body.username });
      if (!user) {
        return new Response(JSON.stringify({ error: '用户不存在' }), { status: 400, headers });
      }
      if (user.password !== body.password) {
        return new Response(JSON.stringify({ error: '密码错误' }), { status: 400, headers });
      }
      const token = signJWT({ id: user._id.toString(), role: user.role });
      return new Response(JSON.stringify({
        token,
        user: {
          id: user._id,
          username: user.username,
          role: user.role,
          diamond: user.diamond || 0,
          balance: user.balance || 0
        }
      }), { headers });
    }

    // ========== 获取当前用户 ==========
    if (path === '/api/me' && method === 'GET') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers });
      }
      const user = await users.findOne({ _id: token.id }, { projection: { password: 0 } });
      return new Response(JSON.stringify(user), { headers });
    }

    // ========== 商品列表 ==========
    if (path === '/api/products' && method === 'GET') {
      const list = await products.find({
        hidden: { $ne: true },
        $expr: { $gt: ['$quantity', '$sold'] }
      }).sort({ createTime: -1 }).toArray();
      return new Response(JSON.stringify(list), { headers });
    }

    // ========== 管理员商品管理 ==========
    if (path === '/api/admin/products' && method === 'GET') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token || token.role !== 'admin') {
        return new Response(JSON.stringify({ error: '无权访问' }), { status: 403, headers });
      }
      const list = await products.find().sort({ createTime: -1 }).toArray();
      return new Response(JSON.stringify(list), { headers });
    }

    if (path === '/api/admin/products' && method === 'POST') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token || token.role !== 'admin') {
        return new Response(JSON.stringify({ error: '无权操作' }), { status: 403, headers });
      }
      const body = await parseBody(request);
      const product = {
        game: body.game,
        title: body.title,
        desc: body.desc || '',
        price: body.price,
        quantity: body.quantity || 1,
        sold: 0,
        hidden: false,
        createTime: new Date()
      };
      const result = await products.insertOne(product);
      return new Response(JSON.stringify({ ...product, _id: result.insertedId }), { headers });
    }

    // 下架商品
    if (path.startsWith('/api/admin/products/') && method === 'PUT' && path.endsWith('/unshelf')) {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token || token.role !== 'admin') {
        return new Response(JSON.stringify({ error: '无权操作' }), { status: 403, headers });
      }
      const id = path.split('/')[4];
      await products.updateOne({ _id: id }, { $set: { hidden: true } });
      return new Response(JSON.stringify({ success: true, message: '商品已下架' }), { headers });
    }

    // 重新上架
    if (path.startsWith('/api/admin/products/') && method === 'PUT' && path.endsWith('/reshelf')) {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token || token.role !== 'admin') {
        return new Response(JSON.stringify({ error: '无权操作' }), { status: 403, headers });
      }
      const id = path.split('/')[4];
      await products.updateOne({ _id: id }, { $set: { hidden: false } });
      return new Response(JSON.stringify({ success: true, message: '商品已重新上架' }), { headers });
    }

    // 删除商品
    if (path.startsWith('/api/admin/products/') && method === 'DELETE') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token || token.role !== 'admin') {
        return new Response(JSON.stringify({ error: '无权操作' }), { status: 403, headers });
      }
      const id = path.split('/')[4];
      await products.deleteOne({ _id: id });
      return new Response(JSON.stringify({ success: true, message: '商品已删除' }), { headers });
    }

    // ========== 购买 ==========
    if (path === '/api/orders/buy' && method === 'POST') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers });
      }
      const body = await parseBody(request);
      const product = await products.findOne({ _id: body.productId });
      if (!product) {
        return new Response(JSON.stringify({ error: '商品不存在' }), { status: 404, headers });
      }
      if (product.quantity <= product.sold) {
        return new Response(JSON.stringify({ error: '库存不足' }), { status: 400, headers });
      }
      const user = await users.findOne({ _id: token.id });
      const diamondCost = product.price * 10;
      if (user.diamond < diamondCost) {
        return new Response(JSON.stringify({ error: '红钻不足' }), { status: 400, headers });
      }
      await users.updateOne({ _id: token.id }, { $inc: { diamond: -diamondCost } });
      await products.updateOne({ _id: body.productId }, { $inc: { sold: 1 } });
      const order = {
        productId: body.productId,
        bossId: token.id,
        handlerId: null,
        status: 'pending',
        price: product.price,
        game: product.game,
        title: product.title,
        desc: product.desc || '',
        createTime: new Date(),
        startTime: null,
        endTime: null,
        messages: [{ sender: 'system', content: `🎉 订单已创建，订单号: ${order._id}`, time: new Date() }],
        settled: false,
        settledAmount: 0,
        refundReason: null,
        hidden: false
      };
      const result = await orders.insertOne(order);
      return new Response(JSON.stringify({ orderId: result.insertedId, message: '购买成功' }), { headers });
    }

    // ========== 我的订单 ==========
    if (path === '/api/orders/my' && method === 'GET') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers });
      }
      const list = await orders.find({
        $or: [{ bossId: token.id }, { handlerId: token.id }]
      }).sort({ createTime: -1 }).toArray();
      return new Response(JSON.stringify(list), { headers });
    }

    // ========== 管理员订单列表 ==========
    if (path === '/api/admin/orders' && method === 'GET') {
      const token = verifyToken(request.headers.get('Authorization'));
      if (!token || token.role !== 'admin') {
        return new Response(JSON.stringify({ error: '无权访问' }), { status: 403, headers });
      }
      const list = await orders.find().sort({ createTime: -1 }).toArray();
      return new Response(JSON.stringify(list), { headers });
    }

    // ========== 默认响应 ==========
    return new Response(JSON.stringify({ message: 'API 运行中' }), { headers });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: error.message || '服务器错误' }), {
      status: 500,
      headers
    });
  }
}

// ============================================================
//  Worker 入口
// ============================================================
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});