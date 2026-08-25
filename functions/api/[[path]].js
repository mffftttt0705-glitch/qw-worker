// ============================================================
//  QW电竞 - 完整后端 API（全功能版）
//  包含：用户、商品、分类/子分类、订单、充值、客服、消息、打手提现
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

async function queryDB(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  if (params.length > 0) {
    return await stmt.bind(...params).all();
  }
  return await stmt.all();
}

async function runDB(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  if (params.length > 0) {
    return await stmt.bind(...params).run();
  }
  return await stmt.run();
}

async function getUserById(env, userId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  return (result.results && result.results[0]) || null;
}

function verifyAndGetUserId(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split('.');
  if (parts.length !== 2) return null;
  return parts[1];
}

// ============================================================
//  用户认证
// ============================================================
async function handleRegister(env, body) {
  const { username, password, role } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');
  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) return errorResponse('用户名已存在');
  const id = generateId();
  const userStatus = (role === 'handler' || role === 'dispatcher' || role === 'service') ? 'pending' : 'active';
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, frozen_diamond, status) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
    [id, username, password, role || 'boss', userStatus]
  );
  return jsonResponse({ message: (role === 'handler' || role === 'dispatcher' || role === 'service') ? '注册成功，请等待管理员审核' : '注册成功', id });
}

async function handleLogin(env, body) {
  const { username, password } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');
  const result = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在');
  if (user.password !== password) return errorResponse('密码错误');
  if (user.status === 'banned') return errorResponse('账号已被封禁');
  if ((user.role === 'handler' || user.role === 'dispatcher' || user.role === 'service') && user.status !== 'active') {
    return errorResponse('账号待审核，请等待管理员审核通过后再登录');
  }
  const token = generateId() + '.' + user.id;
  return jsonResponse({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role || 'boss',
      diamond: user.diamond || 0,
      frozen_diamond: user.frozen_diamond || 0,
      balance: user.balance || 0,
      status: user.status || 'active'
    }
  });
}

async function handleGetMe(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { password, ...rest } = user;
  return jsonResponse(rest);
}

// ============================================================
//  分类 & 子分类
// ============================================================
async function handleGetCategories(env) {
  const result = await queryDB(env, 'SELECT * FROM categories ORDER BY sort_order ASC, created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleGetSubCategories(env, categoryId) {
  const result = await queryDB(env, 'SELECT * FROM sub_categories WHERE category_id = ? ORDER BY sort_order ASC', [categoryId]);
  return jsonResponse(result.results || []);
}

async function handleAdminCreateCategory(env, body) {
  const { name, image, sort_order } = body;
  if (!name) return errorResponse('请填写分类名称');
  const id = generateId();
  await runDB(env,
    'INSERT INTO categories (id, name, image, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, name, image || '', sort_order || 0, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '分类创建成功' });
}

async function handleAdminCreateSubCategory(env, body) {
  const { category_id, name, sort_order } = body;
  if (!category_id || !name) return errorResponse('请填写完整信息');
  const id = generateId();
  await runDB(env,
    'INSERT INTO sub_categories (id, category_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, category_id, name, sort_order || 0, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '子分类创建成功' });
}

async function handleAdminDeleteSubCategory(env, subCategoryId) {
  await runDB(env, 'DELETE FROM sub_categories WHERE id = ?', [subCategoryId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  商品（含子分类关联）
// ============================================================
async function handleGetProducts(env, url) {
  const category = url?.searchParams?.get('category');
  const subCategory = url?.searchParams?.get('subCategory');
  let sql = `SELECT p.*, c.name as category_name, s.name as sub_category_name 
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id 
             LEFT JOIN sub_categories s ON p.sub_category_id = s.id 
             WHERE p.hidden = 0`;
  const params = [];
  if (category) {
    sql += ' AND p.category_id = ?';
    params.push(category);
  }
  if (subCategory) {
    sql += ' AND p.sub_category_id = ?';
    params.push(subCategory);
  }
  sql += ' ORDER BY p.created_at DESC';
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleAdminCreateProduct(env, body) {
  const { game, title, desc, price, quantity, image, category_id, sub_category_id, detail_images, detail_desc } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const id = generateId();
  const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
  await runDB(env,
    `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, detail_images, detail_desc, category_id, sub_category_id) 
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', detailImagesJson, detail_desc || '', category_id || null, sub_category_id || null]
  );
  return jsonResponse({ success: true, id });
}

async function handleAdminUpdateProduct(env, productId, body) {
  const { game, title, desc, price, quantity, image, category_id, sub_category_id, detail_images, detail_desc } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
  await runDB(env,
    `UPDATE products SET game = ?, title = ?, description = ?, price = ?, quantity = ?, image = ?, category_id = ?, sub_category_id = ?, detail_images = ?, detail_desc = ? WHERE id = ?`,
    [game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', category_id || null, sub_category_id || null, detailImagesJson, detail_desc || '', productId]
  );
  return jsonResponse({ success: true, message: '商品已更新' });
}

// ============================================================
//  订单（含打手接单需100红钻冻结）
// ============================================================
async function handleTakeOrder(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可接单');
  if (user.status !== 'active') return errorResponse('账号未激活');
  
  // 打手接单需至少100红钻（冻结）
  if (user.diamond < 100) return errorResponse('接单需要至少100红钻（冻结）');
  
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.status !== 'pending') return errorResponse('订单不可接');
  
  // 冻结100红钻
  await runDB(env, 'UPDATE users SET diamond = diamond - 100, frozen_diamond = frozen_diamond + 100 WHERE id = ?', [userId]);
  await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?', [userId, new Date().toISOString(), orderId]);
  return jsonResponse({ message: '接单成功，已冻结100红钻' });
}

// 打手完成订单（解冻红钻）
async function handleSubmitComplete(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可操作');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.handler_id !== userId) return errorResponse('不是你的订单', 403);
  if (order.status !== 'ongoing') return errorResponse('只有进行中可提交');
  await runDB(env, 'UPDATE orders SET status = "review" WHERE id = ?', [orderId]);
  return jsonResponse({ message: '已提交验收' });
}

// 订单完成后解冻打手红钻
async function handleBossConfirm(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'boss' && user.role !== 'service') return errorResponse('只有老板或客服可操作');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && user.role !== 'service') return errorResponse('不是你的订单', 403);
  if (order.status !== 'review') return errorResponse('只有待验收可确认');
  
  // 解冻打手红钻（100）
  if (order.handler_id) {
    await runDB(env, 'UPDATE users SET frozen_diamond = frozen_diamond - 100 WHERE id = ?', [order.handler_id]);
  }
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '已确认完成，红钻已解冻' });
}

// ============================================================
//  提现功能（打手）
// ============================================================
async function handleWithdraw(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可提现');
  
  const { amount, accountInfo } = body;
  if (!amount || amount < 1) return errorResponse('请输入有效金额');
  const available = (user.diamond || 0) - (user.frozen_diamond || 0);
  if (amount > available) return errorResponse(`可用红钻不足，当前可用 ${available}`);
  
  const id = generateId();
  await runDB(env,
    'INSERT INTO withdraw_requests (id, user_id, amount, account_info, status, created_at) VALUES (?, ?, ?, ?, "pending", ?)',
    [id, userId, amount, accountInfo || '', new Date().toISOString()]
  );
  // 扣除红钻
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [amount, userId]);
  return jsonResponse({ success: true, message: '提现申请已提交' });
}

async function handleGetWithdraws(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const result = await queryDB(env,
    `SELECT w.*, u.username 
     FROM withdraw_requests w 
     LEFT JOIN users u ON w.user_id = u.id 
     ORDER BY w.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleProcessWithdraw(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const { requestId, action, rejectReason } = body;
  if (!requestId || !action) return errorResponse('参数不完整');
  const req = await queryDB(env, 'SELECT * FROM withdraw_requests WHERE id = ?', [requestId]);
  if (!req.results || req.results.length === 0) return errorResponse('申请不存在');
  const request = req.results[0];
  if (request.status !== 'pending') return errorResponse('已处理');
  if (action === 'approve') {
    await runDB(env,
      'UPDATE withdraw_requests SET status = "approved", handler_id = ?, handled_at = ? WHERE id = ?',
      [userId, new Date().toISOString(), requestId]
    );
    return jsonResponse({ success: true, message: '提现已通过' });
  } else {
    // 拒绝时退还红钻
    if (request.user_id) {
      await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [request.amount, request.user_id]);
    }
    await runDB(env,
      'UPDATE withdraw_requests SET status = "rejected", handler_id = ?, reject_reason = ?, handled_at = ? WHERE id = ?',
      [userId, rejectReason || '无原因', new Date().toISOString(), requestId]
    );
    return jsonResponse({ success: true, message: '已拒绝' });
  }
}

// ============================================================
//  用户详情（含订单统计）
// ============================================================
async function handleGetUserDetail(env, authHeader, targetUserId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  
  const target = await getUserById(env, targetUserId);
  if (!target) return errorResponse('用户不存在', 404);
  
  // 获取订单统计
  const orders = await queryDB(env,
    `SELECT * FROM orders WHERE boss_id = ? OR handler_id = ? ORDER BY created_at DESC`,
    [targetUserId, targetUserId]
  );
  
  return jsonResponse({
    user: target,
    orders: orders.results || [],
    stats: {
      total_orders: orders.results?.length || 0,
      completed_orders: orders.results?.filter(o => o.status === 'completed').length || 0,
      total_spent: orders.results?.filter(o => o.boss_id === targetUserId).reduce((sum, o) => sum + o.price, 0) || 0,
      total_earned: orders.results?.filter(o => o.handler_id === targetUserId && o.status === 'completed').reduce((sum, o) => sum + o.price, 0) || 0
    }
  });
}

// ============================================================
//  客服主动添加联系人
// ============================================================
async function handleAddContact(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  
  const { targetUserId } = body;
  if (!targetUserId) return errorResponse('请选择用户');
  const target = await getUserById(env, targetUserId);
  if (!target) return errorResponse('用户不存在', 404);
  
  const exist = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [targetUserId, userId]);
  if (exist.results && exist.results.length > 0) {
    return errorResponse('已添加为联系人');
  }
  
  await runDB(env,
    'INSERT INTO message_contacts (id, user_id, contact_id, is_active, last_time, created_by) VALUES (?, ?, ?, 1, ?, ?)',
    [generateId(), targetUserId, userId, new Date().toISOString(), userId]
  );
  await runDB(env,
    'INSERT INTO message_contacts (id, user_id, contact_id, is_active, last_time, created_by) VALUES (?, ?, ?, 1, ?, ?)',
    [generateId(), userId, targetUserId, new Date().toISOString(), userId]
  );
  return jsonResponse({ success: true, message: '已添加联系人' });
}

// ============================================================
//  消息系统（每个用户独立对话）
// ============================================================
async function handleSendMessage(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  const { receiverId, content } = body;
  if (!receiverId || !content) return errorResponse('请完整填写');
  const receiver = await getUserById(env, receiverId);
  if (!receiver) return errorResponse('接收者不存在');
  
  // 普通用户只能发给客服/管理员
  if (user.role !== 'admin' && user.role !== 'service') {
    if (receiver.role !== 'admin' && receiver.role !== 'service') {
      return errorResponse('只能联系客服或管理员', 403);
    }
  }
  
  const id = generateId();
  await runDB(env,
    'INSERT INTO messages (id, sender_id, receiver_id, content, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [id, userId, receiverId, content.trim(), new Date().toISOString()]
  );
  
  // 更新联系人
  const c1 = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [userId, receiverId]);
  if (!c1.results || c1.results.length === 0) {
    await runDB(env,
      'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count, is_active) VALUES (?, ?, ?, ?, ?, 0, 1)',
      [generateId(), userId, receiverId, content.trim(), new Date().toISOString()]
    );
  } else {
    await runDB(env,
      'UPDATE message_contacts SET last_message = ?, last_time = ? WHERE user_id = ? AND contact_id = ?',
      [content.trim(), new Date().toISOString(), userId, receiverId]
    );
  }
  
  const c2 = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [receiverId, userId]);
  if (!c2.results || c2.results.length === 0) {
    await runDB(env,
      'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count, is_active) VALUES (?, ?, ?, ?, ?, 1, 1)',
      [generateId(), receiverId, userId, content.trim(), new Date().toISOString()]
    );
  } else {
    await runDB(env,
      'UPDATE message_contacts SET last_message = ?, last_time = ?, unread_count = unread_count + 1 WHERE user_id = ? AND contact_id = ?',
      [content.trim(), new Date().toISOString(), receiverId, userId]
    );
  }
  return jsonResponse({ success: true, message: '发送成功' });
}

async function handleGetContacts(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  
  let sql = '';
  if (user.role === 'admin' || user.role === 'service') {
    sql = `SELECT DISTINCT 
            u.id, u.username, u.role,
            mc.last_message, mc.last_time, mc.unread_count
            FROM message_contacts mc
            JOIN users u ON mc.contact_id = u.id
            WHERE mc.user_id = ? AND mc.is_active = 1
            ORDER BY mc.last_time DESC`;
  } else {
    sql = `SELECT DISTINCT 
            u.id, u.username, u.role,
            mc.last_message, mc.last_time, mc.unread_count
            FROM message_contacts mc
            JOIN users u ON mc.contact_id = u.id
            WHERE mc.user_id = ? AND mc.is_active = 1
            AND u.role IN ('admin', 'service')
            ORDER BY mc.last_time DESC`;
  }
  const result = await queryDB(env, sql, [userId]);
  return jsonResponse(result.results || []);
}

// 获取所有用户（管理员/客服添加联系人用）
async function handleGetAllUsers(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const result = await queryDB(env, 'SELECT id, username, role FROM users WHERE id != ?', [userId]);
  return jsonResponse(result.results || []);
}

// ============================================================
//  其他辅助函数（充值、打赏等保持不变）
// ============================================================
async function handleCustomRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { amount } = body;
  if (!amount || amount < 1) return errorResponse('请输入有效金额');
  const diamond = Math.floor(amount * 10);
  const id = generateId();
  await runDB(env,
    'INSERT INTO recharge_requests (id, user_id, amount, diamond, status) VALUES (?, ?, ?, ?, "pending")',
    [id, userId, amount, diamond]
  );
  return jsonResponse({ success: true, message: `充值申请已提交，可获得 ${diamond} 红钻` });
}

async function handleGetPendingRecharges(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const result = await queryDB(env,
    `SELECT r.*, u.username FROM recharge_requests r LEFT JOIN users u ON r.user_id = u.id WHERE r.status = 'pending' ORDER BY r.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleProcessRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const { requestId, action, rejectReason } = body;
  if (!requestId || !action) return errorResponse('参数不完整');
  const req = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [requestId]);
  if (!req.results || req.results.length === 0) return errorResponse('申请不存在');
  const request = req.results[0];
  if (request.status !== 'pending') return errorResponse('已处理');
  if (action === 'approve') {
    if (user.diamond < request.diamond) return errorResponse(`红钻不足，需要 ${request.diamond} 红钻`);
    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [request.diamond, userId]);
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [request.diamond, request.user_id]);
    await runDB(env, 'UPDATE recharge_requests SET status = "approved", handler_id = ?, handled_at = ? WHERE id = ?', [userId, new Date().toISOString(), requestId]);
    return jsonResponse({ success: true, message: `充值已通过，已扣除 ${request.diamond} 红钻` });
  } else {
    await runDB(env, 'UPDATE recharge_requests SET status = "rejected", handler_id = ?, reject_reason = ?, handled_at = ? WHERE id = ?', [userId, rejectReason || '无原因', new Date().toISOString(), requestId]);
    return jsonResponse({ success: true, message: '已拒绝' });
  }
}

// ============================================================
//  入口路由（仅保留核心路由）
// ============================================================
export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const env = context.env;

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
    const authHeader = request.headers.get('Authorization');

    // 公开接口
    if (path === '/api/register' && method === 'POST') return await handleRegister(env, body);
    if (path === '/api/login' && method === 'POST') return await handleLogin(env, body);
    if (path === '/api/products' && method === 'GET') return await handleGetProducts(env, url);
    if (path === '/api/categories' && method === 'GET') return await handleGetCategories(env);
    if (path === '/api/categories/sub' && method === 'GET') {
      const categoryId = url.searchParams.get('categoryId');
      return await handleGetSubCategories(env, categoryId);
    }

    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    // 需要登录的接口
    if (path === '/api/me' && method === 'GET') return await handleGetMe(env, authHeader);
    if (path === '/api/orders/take' && method === 'POST') return await handleTakeOrder(env, authHeader, body.orderId);
    if (path === '/api/orders/submit' && method === 'POST') return await handleSubmitComplete(env, authHeader, body.orderId);
    if (path === '/api/orders/confirm' && method === 'POST') return await handleBossConfirm(env, authHeader, body.orderId);
    if (path === '/api/recharge/custom' && method === 'POST') return await handleCustomRecharge(env, authHeader, body);
    if (path === '/api/withdraw' && method === 'POST') return await handleWithdraw(env, authHeader, body);
    if (path === '/api/messages/send' && method === 'POST') return await handleSendMessage(env, authHeader, body);
    if (path === '/api/messages/contacts' && method === 'GET') return await handleGetContacts(env, authHeader);
    if (path === '/api/messages/history' && method === 'POST') {
      const result = await queryDB(env,
        `SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY created_at ASC`,
        [userId, body.contactId, body.contactId, userId]
      );
      await runDB(env, 'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?', [body.contactId, userId]);
      await runDB(env, 'UPDATE message_contacts SET unread_count = 0 WHERE user_id = ? AND contact_id = ?', [userId, body.contactId]);
      return jsonResponse(result.results || []);
    }
    if (path === '/api/messages/unread' && method === 'GET') {
      const result = await queryDB(env, 'SELECT SUM(unread_count) as total FROM message_contacts WHERE user_id = ?', [userId]);
      return jsonResponse({ unread: (result.results && result.results[0] && result.results[0].total) || 0 });
    }

    // 管理员/客服接口
    if (user.role === 'admin' || user.role === 'service') {
      if (path === '/api/admin/categories' && method === 'POST') return await handleAdminCreateCategory(env, body);
      if (path === '/api/admin/subcategories' && method === 'POST') return await handleAdminCreateSubCategory(env, body);
      if (path === '/api/admin/subcategories' && method === 'DELETE') return await handleAdminDeleteSubCategory(env, body.subCategoryId);
      if (path === '/api/admin/products' && method === 'POST') return await handleAdminCreateProduct(env, body);
      if (path === '/api/admin/products' && method === 'PUT') return await handleAdminUpdateProduct(env, body.productId, body);
      if (path === '/api/admin/recharges/pending' && method === 'GET') return await handleGetPendingRecharges(env, authHeader);
      if (path === '/api/admin/recharges/process' && method === 'POST') return await handleProcessRecharge(env, authHeader, body);
      if (path === '/api/admin/withdraws' && method === 'GET') return await handleGetWithdraws(env, authHeader);
      if (path === '/api/admin/withdraws/process' && method === 'POST') return await handleProcessWithdraw(env, authHeader, body);
      if (path === '/api/admin/users/detail' && method === 'GET') return await handleGetUserDetail(env, authHeader, url.searchParams.get('userId'));
      if (path === '/api/admin/users/all' && method === 'GET') return await handleGetAllUsers(env, authHeader);
      if (path === '/api/admin/contacts/add' && method === 'POST') return await handleAddContact(env, authHeader, body);
    }

    return errorResponse('接口不存在', 404);
  } catch (err) {
    console.error('错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}