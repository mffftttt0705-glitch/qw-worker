// ============================================================
//  QW电竞 - 完整后端 API
//  包含：用户、商品、订单、分类、充值、客服、消息
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

// ============================================================
//  用户认证
// ============================================================
async function handleRegister(env, body) {
  const { username, password, role, status } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已存在');
  }

  const id = generateId();
  // 打手、派单、客服默认为待审核
  const userStatus = (role === 'handler' || role === 'dispatcher' || role === 'service') ? 'pending' : (status || 'active');
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, status) VALUES (?, ?, ?, ?, 0, 0, ?)',
    [id, username, password, role || 'boss', userStatus]
  );

  return jsonResponse({ 
    message: (role === 'handler' || role === 'dispatcher' || role === 'service') ? '注册成功，请等待管理员审核' : '注册成功', 
    id 
  });
}

async function handleLogin(env, body) {
  const { username, password } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const result = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在');
  if (user.password !== password) return errorResponse('密码错误');
  if (user.status === 'banned') return errorResponse('账号已被封禁');
  
  // 打手/派单/客服需审核通过
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
//  分类管理
// ============================================================
async function handleGetCategories(env) {
  const result = await queryDB(env, 'SELECT * FROM categories ORDER BY sort_order ASC, created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminCreateCategory(env, body) {
  const { name, image, sort_order, parent_id } = body;
  const categoryName = String(name || '').trim();
  if (!categoryName) return errorResponse('请填写分类名称');

  // 子分类必须挂在真实存在的主分类下面
  if (parent_id) {
    const parent = await queryDB(
      env,
      "SELECT id FROM categories WHERE id = ? AND (parent_id IS NULL OR parent_id = '')",
      [parent_id]
    );
    if (!parent.results || parent.results.length === 0) {
      return errorResponse('所属主分类不存在', 400);
    }
  }

  const id = generateId();
  await runDB(env,
    `INSERT INTO categories
      (id, name, image, sort_order, parent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      categoryName,
      image || '',
      Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
      parent_id || null,
      new Date().toISOString()
    ]
  );

  return jsonResponse({
    success: true,
    id,
    parent_id: parent_id || null,
    message: parent_id ? '子分类创建成功' : '主分类创建成功'
  });
}

async function handleAdminUpdateCategory(env, categoryId, body) {
  const { name, image, sort_order, parent_id } = body;

  const currentResult = await queryDB(env, 'SELECT * FROM categories WHERE id = ?', [categoryId]);
  const current = currentResult.results && currentResult.results[0];
  if (!current) return errorResponse('分类不存在', 404);

  if (name === undefined && image === undefined && sort_order === undefined && parent_id === undefined) {
    return errorResponse('没有要更新的字段');
  }

  if (parent_id !== undefined) {
    if (parent_id && parent_id === categoryId) {
      return errorResponse('分类不能设置自己为父分类', 400);
    }
    if (parent_id) {
      const parent = await queryDB(
        env,
        "SELECT id FROM categories WHERE id = ? AND (parent_id IS NULL OR parent_id = '')",
        [parent_id]
      );
      if (!parent.results || parent.results.length === 0) {
        return errorResponse('所属主分类不存在', 400);
      }
    }
  }

  const updates = [];
  const params = [];
  if (name !== undefined) {
    const categoryName = String(name || '').trim();
    if (!categoryName) return errorResponse('分类名称不能为空');
    updates.push('name = ?');
    params.push(categoryName);
  }
  if (image !== undefined) {
    updates.push('image = ?');
    params.push(image || '');
  }
  if (sort_order !== undefined) {
    updates.push('sort_order = ?');
    params.push(Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0);
  }
  if (parent_id !== undefined) {
    updates.push('parent_id = ?');
    params.push(parent_id || null);
  }

  params.push(categoryId);
  await runDB(env, `UPDATE categories SET ${updates.join(', ')} WHERE id = ?`, params);
  return jsonResponse({ success: true, message: '分类已更新' });
}

async function handleAdminDeleteCategory(env, categoryId) {
  const categoryResult = await queryDB(env, 'SELECT id, parent_id FROM categories WHERE id = ?', [categoryId]);
  const category = categoryResult.results && categoryResult.results[0];
  if (!category) return errorResponse('分类不存在', 404);

  const productCheck = await queryDB(
    env,
    'SELECT COUNT(*) as count FROM products WHERE category_id = ?',
    [categoryId]
  );
  if (productCheck.results && productCheck.results[0] && productCheck.results[0].count > 0) {
    return errorResponse('该分类下还有商品，请先移除商品或修改商品分类', 400);
  }

  // 主分类还有子分类时禁止删除，避免产生孤儿子分类
  if (!category.parent_id) {
    const childCheck = await queryDB(
      env,
      'SELECT COUNT(*) as count FROM categories WHERE parent_id = ?',
      [categoryId]
    );
    if (childCheck.results && childCheck.results[0] && childCheck.results[0].count > 0) {
      return errorResponse('该主分类下还有子分类，请先删除或迁移子分类', 400);
    }
  }

  await runDB(env, 'DELETE FROM categories WHERE id = ?', [categoryId]);
  return jsonResponse({
    success: true,
    message: category.parent_id ? '子分类已删除' : '主分类已删除'
  });
}

async function handleGetCategoryProducts(env, categoryId) {
  // 主分类：同时返回直接挂在主分类下，以及挂在该主分类所有子分类下的商品。
  // 子分类：只返回该子分类自己的商品。
  const categoryResult = await queryDB(
    env,
    'SELECT id, parent_id FROM categories WHERE id = ?',
    [categoryId]
  );
  const category = categoryResult.results && categoryResult.results[0];
  if (!category) return jsonResponse([]);

  let result;
  if (!category.parent_id) {
    result = await queryDB(
      env,
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.hidden = 0
         AND (p.category_id = ? OR p.category_id IN (
           SELECT id FROM categories WHERE parent_id = ?
         ))
       ORDER BY p.created_at DESC`,
      [categoryId, categoryId]
    );
  } else {
    result = await queryDB(
      env,
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.category_id = ? AND p.hidden = 0
       ORDER BY p.created_at DESC`,
      [categoryId]
    );
  }

  return jsonResponse(result.results || []);
}

// ============================================================
//  商品管理
// ============================================================
async function handleGetProducts(env, url) {
  const category = url?.searchParams?.get('category');
  let sql = `SELECT p.*, c.name as category_name 
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id 
             WHERE p.hidden = 0`;
  const params = [];
  if (category) {
    sql += ' AND p.category_id = ?';
    params.push(category);
  }
  sql += ' ORDER BY p.created_at DESC';
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleGetProductDetail(env, productId) {
  const result = await queryDB(env,
    `SELECT p.*, c.name as category_name 
     FROM products p 
     LEFT JOIN categories c ON p.category_id = c.id 
     WHERE p.id = ?`,
    [productId]
  );
  const product = (result.results && result.results[0]) || null;
  if (!product) return errorResponse('商品不存在', 404);
  let detailImages = [];
  if (product.detail_images) {
    try { detailImages = JSON.parse(product.detail_images); } catch(e) { detailImages = []; }
  }
  if (detailImages.length === 0 && product.image) {
    detailImages = [product.image];
  }
  product.detail_images = detailImages;
  return jsonResponse(product);
}

async function handleAdminGetProducts(env) {
  const result = await queryDB(env,
    `SELECT p.*, c.name as category_name 
     FROM products p 
     LEFT JOIN categories c ON p.category_id = c.id 
     ORDER BY p.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminCreateProduct(env, body) {
  const { game, title, desc, price, quantity, image, category_id, detail_images, detail_desc } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const id = generateId();
  const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
  await runDB(env,
    `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, detail_images, detail_desc, category_id) 
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', detailImagesJson, detail_desc || '', category_id || null]
  );
  return jsonResponse({ success: true, id });
}

async function handleAdminUpdateProduct(env, productId, body) {
  const { game, title, desc, price, quantity, image, category_id, detail_images, detail_desc } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
  await runDB(env,
    `UPDATE products SET game = ?, title = ?, description = ?, price = ?, quantity = ?, image = ?, category_id = ?, detail_images = ?, detail_desc = ? WHERE id = ?`,
    [game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', category_id || null, detailImagesJson, detail_desc || '', productId]
  );
  return jsonResponse({ success: true, message: '商品已更新' });
}

async function handleAdminUnshelf(env, productId) {
  const check = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
  if (!check.results || check.results.length === 0) return errorResponse('商品不存在', 404);
  await runDB(env, 'UPDATE products SET hidden = 1 WHERE id = ?', [productId]);
  return jsonResponse({ success: true, message: '已下架' });
}

async function handleAdminReshelf(env, productId) {
  const check = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
  if (!check.results || check.results.length === 0) return errorResponse('商品不存在', 404);
  await runDB(env, 'UPDATE products SET hidden = 0 WHERE id = ?', [productId]);
  return jsonResponse({ success: true, message: '已重新上架' });
}

async function handleAdminDeleteProduct(env, productId) {
  await runDB(env, 'DELETE FROM products WHERE id = ?', [productId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  派单员上架商品
// ============================================================
async function handleDispatcherCreateProduct(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('只有派单员或管理员可上架商品', 403);
  }
  const { game, title, desc, price, quantity, image, category_id } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const id = generateId();
  await runDB(env,
    `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, category_id, created_by) 
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', category_id || null, userId]
  );
  return jsonResponse({ success: true, id, message: '商品上架成功' });
}

// ============================================================
//  派单员发布订单
// ============================================================
async function handleDispatcherPublish(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('只有派单员或管理员可发布订单', 403);
  }
  const { game, title, desc, price, assignedHandlerId } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  if (price < 1) return errorResponse('价格至少为1红钻');
  if (user.diamond < price) {
    return errorResponse(`红钻不足，需要 ${price} 红钻，当前仅有 ${user.diamond} 红钻`, 400);
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [price, userId]);
  const orderId = generateId();
  let status = 'pending';
  let handlerId = assignedHandlerId || null;
  let messages = JSON.stringify([{ sender: 'system', content: `📋 派单员发布订单：${title}`, time: new Date().toISOString() }]);
  if (handlerId) {
    const handlerCheck = await queryDB(env, 'SELECT * FROM users WHERE id = ? AND role = "handler" AND status = "active"', [handlerId]);
    if (handlerCheck.results && handlerCheck.results.length > 0) {
      status = 'ongoing';
      messages = JSON.stringify([{ sender: 'system', content: `📋 派单员发布订单：${title}，已指派打手`, time: new Date().toISOString() }]);
    } else {
      handlerId = null;
    }
  }
  await runDB(env,
    `INSERT INTO orders (id, boss_id, handler_id, status, price, game, title, description, messages, start_time) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, userId, handlerId, status, parseFloat(price), game || '暗区突围', title, desc || '', messages, handlerId ? new Date().toISOString() : null]
  );
  return jsonResponse({ success: true, orderId, message: `订单发布成功，已冻结 ${price} 红钻${handlerId ? '，已指派打手' : ''}` });
}

// ============================================================
//  订单购买
// ============================================================
async function handleBuyProduct(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { productId, assignedHandlerId } = body;
  if (!productId) return errorResponse('请选择商品');
  const prodResult = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
  const product = (prodResult.results && prodResult.results[0]) || null;
  if (!product) return errorResponse('商品不存在', 404);
  const sold = product.sold || 0;
  if (product.quantity <= sold) return errorResponse('库存不足');
  const diamondCost = product.price * 10;
  if (user.diamond < diamondCost) return errorResponse('红钻不足，请先充值');
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);
  const orderId = generateId();
  await runDB(env,
    `INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages, handler_id) 
     VALUES (?, ?, ?, "pending", ?, ?, ?, ?, ?, ?)`,
    [orderId, productId, userId, product.price, product.game, product.title, product.desc || '', 
     JSON.stringify([{ sender: 'system', content: '🎉 订单已创建', time: new Date().toISOString() }]),
     assignedHandlerId || null]
  );
  await runDB(env, 'UPDATE products SET sold = sold + 1 WHERE id = ?', [productId]);
  return jsonResponse({ orderId, message: '购买成功' });
}

async function handleGetMyOrders(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  let sql = '';
  if (user.role === 'boss' || user.role === 'service') {
    sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
  } else if (user.role === 'handler') {
    const pendingResult = await queryDB(env, 'SELECT * FROM orders WHERE status = "pending" ORDER BY created_at DESC');
    const myResult = await queryDB(env, 'SELECT * FROM orders WHERE handler_id = ? ORDER BY created_at DESC', [userId]);
    const all = [...(pendingResult.results || []), ...(myResult.results || [])];
    const seen = new Set();
    const unique = all.filter(o => { const key = o.id; if (seen.has(key)) return false; seen.add(key); return true; });
    return jsonResponse(unique);
  } else if (user.role === 'dispatcher') {
    sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
  } else {
    return errorResponse('无权查看', 403);
  }
  const result = await queryDB(env, sql, [userId]);
  return jsonResponse(result.results || []);
}

async function handleGetOrderDetail(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('无权查看', 403);
  }
  return jsonResponse(order);
}

// ============================================================
//  打手功能
// ============================================================
async function handleTakeOrder(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可接单');
  if (user.status !== 'active') return errorResponse('账号未激活，请联系管理员');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.status !== 'pending') return errorResponse('订单不可接');
  await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?', [userId, new Date().toISOString(), orderId]);
  return jsonResponse({ message: '接单成功' });
}

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

async function handleBossConfirm(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'boss' && user.role !== 'service') {
    return errorResponse('只有老板或客服可操作', 403);
  }
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && user.role !== 'service') {
    return errorResponse('不是你的订单', 403);
  }
  if (order.status !== 'review') return errorResponse('只有待验收可确认');
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '已确认完成，等待管理员结算' });
}

async function handleRefundRequest(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'boss' && user.role !== 'service') {
    return errorResponse('只有老板或客服可发起退款', 403);
  }
  const { reason } = body;
  if (!reason) return errorResponse('请填写退款原因');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && user.role !== 'service') {
    return errorResponse('不是你的订单', 403);
  }
  if (order.status === 'completed') return errorResponse('已完成订单不可退款');
  if (order.status === 'refunded' || order.status === 'refund_pending') return errorResponse('已处理退款');
  await runDB(env, 'UPDATE orders SET status = "refund_pending", refund_reason = ? WHERE id = ?', [reason, orderId]);
  return jsonResponse({ success: true, message: '退款申请已提交' });
}

// ============================================================
//  派单员确认完成（扣除自己红钻）
// ============================================================
async function handleDispatcherConfirmComplete(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('只有派单员或管理员可操作', 403);
  }
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && user.role !== 'admin') {
    return errorResponse('不是你的订单', 403);
  }
  if (order.status !== 'ongoing' && order.status !== 'pending') {
    return errorResponse('只有进行中或待接单可确认', 400);
  }
  const diamondCost = order.price;
  if (user.diamond < diamondCost) {
    return errorResponse(`红钻不足，需要 ${diamondCost} 红钻支付订单`);
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);
  const handlerEarning = Math.floor(order.price * 0.8);
  if (order.handler_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [handlerEarning, order.handler_id]);
  }
  await runDB(env, 
    'UPDATE orders SET status = "completed", end_time = ?, settled = 1, settled_amount = ? WHERE id = ?', 
    [new Date().toISOString(), handlerEarning, orderId]
  );
  return jsonResponse({ success: true, message: `验收完成，打手获得 ${handlerEarning} 红钻，平台扣除 ${order.price - handlerEarning} 红钻手续费` });
}

// ============================================================
//  打赏功能
// ============================================================
async function handleSendTip(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { handlerId, amount } = body;
  if (!handlerId || !amount || amount < 1) {
    return errorResponse('请选择打手并输入有效红钻数量');
  }
  if (user.diamond < amount) {
    return errorResponse('红钻不足');
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [amount, userId]);
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, handlerId]);
  return jsonResponse({ success: true, message: `打赏 ${amount} 红钻成功` });
}

// ============================================================
//  自定义充值（用户提交）
// ============================================================
async function handleCustomRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { amount } = body;
  if (!amount || amount < 1) return errorResponse('请输入有效金额');
  if (amount > 999999) return errorResponse('金额过大');
  const diamond = Math.floor(amount * 10);
  const id = generateId();
  await runDB(env,
    'INSERT INTO recharge_requests (id, user_id, amount, diamond, status) VALUES (?, ?, ?, ?, "pending")',
    [id, userId, amount, diamond]
  );
  return jsonResponse({ success: true, message: `充值申请已提交，可获得 ${diamond} 红钻，请等待客服审核` });
}

async function handleGetMyRecharges(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env,
    'SELECT * FROM recharge_requests WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return jsonResponse(result.results || []);
}

// ============================================================
//  客服接口
// ============================================================
async function handleGetPendingRecharges(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const result = await queryDB(env,
    `SELECT r.*, u.username 
     FROM recharge_requests r 
     LEFT JOIN users u ON r.user_id = u.id 
     WHERE r.status = 'pending' 
     ORDER BY r.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleProcessRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const { requestId, action, rejectReason } = body;
  if (!requestId || !action) return errorResponse('参数不完整');
  if (action !== 'approve' && action !== 'reject') return errorResponse('无效操作');
  
  const req = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [requestId]);
  if (!req.results || req.results.length === 0) return errorResponse('申请不存在');
  const request = req.results[0];
  if (request.status !== 'pending') return errorResponse('已处理');
  
  if (action === 'approve') {
    if (user.diamond < request.diamond) {
      return errorResponse(`红钻不足，需要 ${request.diamond} 红钻`);
    }
    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [request.diamond, userId]);
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [request.diamond, request.user_id]);
    await runDB(env,
      'UPDATE recharge_requests SET status = "approved", handler_id = ?, handled_at = ? WHERE id = ?',
      [userId, new Date().toISOString(), requestId]
    );
    return jsonResponse({ success: true, message: `充值已通过，已扣除 ${request.diamond} 红钻` });
  } else {
    await runDB(env,
      'UPDATE recharge_requests SET status = "rejected", handler_id = ?, reject_reason = ?, handled_at = ? WHERE id = ?',
      [userId, rejectReason || '无原因', new Date().toISOString(), requestId]
    );
    return jsonResponse({ success: true, message: '已拒绝' });
  }
}

async function handleGetUsersForService(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const result = await queryDB(env,
    'SELECT id, username, role FROM users WHERE role NOT IN ("admin", "service", "handler")'
  );
  return jsonResponse(result.results || []);
}

async function handleServiceGift(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const { targetUserId, amount } = body;
  if (!targetUserId || !amount || amount < 1) return errorResponse('请填写完整信息');
  if (user.diamond < amount) {
    return errorResponse(`红钻不足，需要 ${amount} 红钻`);
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [amount, userId]);
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
  return jsonResponse({ success: true, message: `已赠送 ${amount} 红钻` });
}

// ============================================================
//  消息系统
// ============================================================
async function handleSendMessage(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { receiverId, content } = body;
  if (!receiverId || !content || !content.trim()) return errorResponse('请完整填写');
  const receiver = await getUserById(env, receiverId);
  if (!receiver) return errorResponse('接收者不存在', 404);
  
  // 所有已登录角色均可互相私聊：
  // 管理员 / 客服 / 老板 / 打手 / 派单均可发送和回复。
  // 未登录用户仍会在上面的认证检查中被拦截。
  
  const id = generateId();
  await runDB(env,
    'INSERT INTO messages (id, sender_id, receiver_id, content, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [id, userId, receiverId, content.trim(), new Date().toISOString()]
  );
  
  // 更新发送者联系人
  const c1 = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [userId, receiverId]);
  if (!c1.results || c1.results.length === 0) {
    await runDB(env,
      'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count) VALUES (?, ?, ?, ?, ?, 0)',
      [generateId(), userId, receiverId, content.trim(), new Date().toISOString()]
    );
  } else {
    await runDB(env,
      'UPDATE message_contacts SET last_message = ?, last_time = ? WHERE user_id = ? AND contact_id = ?',
      [content.trim(), new Date().toISOString(), userId, receiverId]
    );
  }
  
  // 更新接收者联系人（未读数+1）
  const c2 = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [receiverId, userId]);
  if (!c2.results || c2.results.length === 0) {
    await runDB(env,
      'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count) VALUES (?, ?, ?, ?, ?, 1)',
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
  if (!user) return errorResponse('用户不存在', 404);
  
  // 所有角色统一查看自己已经建立的对话。
  // 这样管理员 / 客服 / 老板 / 打手 / 派单之间都能正常进入聊天。
  const sql = `SELECT DISTINCT 
          u.id, u.username, u.role,
          mc.last_message, mc.last_time, mc.unread_count
          FROM message_contacts mc
          JOIN users u ON mc.contact_id = u.id
          WHERE mc.user_id = ?
          ORDER BY COALESCE(mc.last_time, '') DESC`;
  const params = [userId];
  
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleGetMessageUsers(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);

  const result = await queryDB(env,
    `SELECT id, username, role, status
     FROM users
     WHERE id != ?
     ORDER BY created_at DESC`,
    [userId]
  );
  return jsonResponse(result.results || []);
}

async function handleGetMessages(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { contactId } = body;
  if (!contactId) return errorResponse('请选择联系人');
  const contact = await getUserById(env, contactId);
  if (!contact) return errorResponse('联系人不存在', 404);
  
  // 所有已登录角色均可查看联系人之间的私聊记录。
  // 角色权限不再限制消息历史，支持双向沟通。
  
  const result = await queryDB(env,
    `SELECT * FROM messages 
     WHERE (sender_id = ? AND receiver_id = ?) 
     OR (sender_id = ? AND receiver_id = ?)
     ORDER BY created_at ASC`,
    [userId, contactId, contactId, userId]
  );
  
  // 标记为已读
  await runDB(env,
    'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?',
    [contactId, userId]
  );
  await runDB(env,
    'UPDATE message_contacts SET unread_count = 0 WHERE user_id = ? AND contact_id = ?',
    [userId, contactId]
  );
  
  return jsonResponse(result.results || []);
}

async function handleGetUnreadCount(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env,
    'SELECT SUM(unread_count) as total FROM message_contacts WHERE user_id = ?',
    [userId]
  );
  const total = (result.results && result.results[0] && result.results[0].total) || 0;
  return jsonResponse({ unread: total });
}

// ============================================================
//  管理员功能（原有，已包含）
// ============================================================
async function handleAdminGetOrders(env) {
  const result = await queryDB(env, 'SELECT * FROM orders ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminGetUsers(env) {
  const result = await queryDB(env, 'SELECT id, username, role, diamond, balance, status, created_at FROM users');
  return jsonResponse(result.results || []);
}

async function handleAdminAssignHandler(env, orderId, body) {
  const { handlerId } = body;
  if (!handlerId) return errorResponse('请选择打手');
  const userResult = await queryDB(env, 'SELECT * FROM users WHERE id = ? AND role = "handler"', [handlerId]);
  if (!userResult.results || userResult.results.length === 0) {
    return errorResponse('打手不存在');
  }
  await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?', [handlerId, new Date().toISOString(), orderId]);
  return jsonResponse({ message: '指派成功' });
}

async function handleAdminForceComplete(env, orderId) {
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '强制完成成功' });
}

async function handleAdminConfirm(env, orderId) {
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '验收通过' });
}

async function handleAdminReject(env, orderId, body) {
  const { reason } = body;
  await runDB(env, 'UPDATE orders SET status = "rejected", refund_reason = ? WHERE id = ?', [reason || '无原因', orderId]);
  return jsonResponse({ message: '已驳回' });
}

async function handleAdminCancelOrder(env, orderId) {
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  await runDB(env, 'UPDATE orders SET status = "canceled" WHERE id = ?', [orderId]);
  if (order && order.boss_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price, order.boss_id]);
  }
  return jsonResponse({ message: '已取消' });
}

async function handleAdminSettle(env, orderId, body) {
  const { earning } = body;
  const amount = parseFloat(earning);
  if (isNaN(amount) || amount < 0) return errorResponse('金额无效');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.settled) return errorResponse('已结算');
  if (order.status !== 'completed') return errorResponse('只有已完成订单可结算');
  if (order.handler_id) {
    const diamondAmount = amount * 10;
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [diamondAmount, order.handler_id]);
  }
  await runDB(env, 'UPDATE orders SET settled = 1, settled_amount = ? WHERE id = ?', [amount, orderId]);
  return jsonResponse({ success: true, message: `结算成功 ${amount} 红钻` });
}

async function handleAdminDirectPublish(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { game, title, desc, price } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const orderId = generateId();
  await runDB(env,
    'INSERT INTO orders (id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, "pending", ?, ?, ?, ?, ?)',
    [orderId, userId, parseFloat(price), game || '暗区突围', title, desc || '', JSON.stringify([{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date().toISOString() }])]
  );
  return jsonResponse({ success: true, orderId });
}

async function handleAdminDeleteOrder(env, orderId) {
  await runDB(env, 'DELETE FROM orders WHERE id = ?', [orderId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  管理员充值管理
// ============================================================
async function handleAdminGetRecharges(env) {
  const result = await queryDB(env,
    `SELECT r.*, u.username 
     FROM recharge_requests r 
     LEFT JOIN users u ON r.user_id = u.id 
     ORDER BY r.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminApproveRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharge_requests SET status = "approved", approve_time = ? WHERE id = ?', [new Date().toISOString(), rechargeId]);
  if (recharge.user_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond || 0, recharge.user_id]);
  }
  return jsonResponse({ success: true, message: '审核通过，红钻已到账' });
}

async function handleAdminRejectRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharge_requests SET status = "rejected", approve_time = ? WHERE id = ?', [new Date().toISOString(), rechargeId]);
  return jsonResponse({ success: true, message: '已拒绝' });
}

async function handleAdminDeleteRecharge(env, rechargeId) {
  await runDB(env, 'DELETE FROM recharge_requests WHERE id = ?', [rechargeId]);
  return jsonResponse({ success: true, message: '已删除' });
}

async function handleAdminGiftDiamond(env, body) {
  const { targetUserId, amount } = body;
  if (!targetUserId || !amount) return errorResponse('请填写完整信息');
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
  return jsonResponse({ success: true, message: '赠送成功' });
}

// ============================================================
//  公告
// ============================================================
async function handleGetAnnounce(env) {
  const result = await queryDB(env, 'SELECT * FROM announces ORDER BY updated_at DESC LIMIT 1');
  const data = (result.results && result.results[0]) || { content: '欢迎使用 QW电竞护航平台！', images: '[]' };
  if (typeof data.images === 'string') {
    try { data.images = JSON.parse(data.images); } catch(e) { data.images = []; }
  }
  return jsonResponse(data);
}

async function handleAdminUpdateAnnounce(env, body) {
  const { content, images } = body;
  await runDB(env, 'DELETE FROM announces');
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
  await runDB(env,
    'INSERT INTO announces (id, content, images, updated_at) VALUES (?, ?, ?, ?)',
    [generateId(), content || '欢迎使用 QW电竞护航平台！', imagesJson, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: '公告已更新' });
}

// ============================================================
//  邮件
// ============================================================
async function handleGetMails(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT * FROM mails WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return jsonResponse(result.results || []);
}

async function handleClaimMail(env, authHeader, mailId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT * FROM mails WHERE id = ?', [mailId]);
  const mail = (result.results && result.results[0]) || null;
  if (!mail) return errorResponse('邮件不存在', 404);
  if (mail.user_id !== userId) return errorResponse('无权操作', 403);
  if (mail.status === 'read') return errorResponse('已领取');
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [mail.diamond || 0, userId]);
  await runDB(env, 'UPDATE mails SET status = "read", claim_time = ? WHERE id = ?', [new Date().toISOString(), mailId]);
  return jsonResponse({ message: '领取成功' });
}

// ============================================================
//  订单聊天
// ============================================================
async function handleSendChat(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { content } = body;
  if (!content) return errorResponse('内容不能为空');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('无权操作', 403);
  }
  const sender = user.role === 'boss' ? 'boss' : user.role === 'handler' ? 'handler' : user.role === 'dispatcher' ? 'dispatcher' : user.role === 'service' ? 'service' : 'admin';
  let messages = [];
  try { messages = JSON.parse(order.messages || '[]'); } catch (e) { messages = []; }
  messages.push({ sender, content, time: new Date().toISOString() });
  await runDB(env, 'UPDATE orders SET messages = ? WHERE id = ?', [JSON.stringify(messages), orderId]);
  return jsonResponse({ message: '发送成功' });
}

// ============================================================
//  管理员：用户管理
// ============================================================
async function handleAdminToggleBan(env, targetUserId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [targetUserId]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在', 404);
  const newStatus = user.status === 'active' ? 'banned' : 'active';
  await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [newStatus, targetUserId]);
  return jsonResponse({ success: true, message: '用户状态已更新' });
}

async function handleAdminResetPassword(env, targetUserId) {
  await runDB(env, 'UPDATE users SET password = "123456" WHERE id = ?', [targetUserId]);
  return jsonResponse({ success: true, message: '密码已重置为 123456' });
}

async function handleApproveHandler(env, targetUserId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [targetUserId]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler' && user.role !== 'dispatcher' && user.role !== 'service') {
    return errorResponse('该用户不是打手、派单员或客服', 403);
  }
  if (user.status !== 'pending') return errorResponse('该用户不需要审核');
  await runDB(env, 'UPDATE users SET status = "active" WHERE id = ?', [targetUserId]);
  return jsonResponse({ success: true, message: '审核通过' });
}

async function handleChangeUsername(env, targetUserId, body) {
  const { username } = body;
  if (!username) return errorResponse('请输入新用户名');
  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ? AND id != ?', [username, targetUserId]);
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已被使用');
  }
  await runDB(env, 'UPDATE users SET username = ? WHERE id = ?', [username, targetUserId]);
  return jsonResponse({ success: true, message: '用户名已修改' });
}

// ============================================================
//  获取打手列表
// ============================================================
async function handleGetHandlers(env) {
  const result = await queryDB(env, 'SELECT id, username FROM users WHERE role = "handler" AND status = "active"');
  return jsonResponse(result.results || []);
}

// ============================================================
//  派单员统计
// ============================================================
async function handleDispatcherStats(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('无权查看', 403);
  }
  const result = await queryDB(env, 
    `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'ongoing' THEN 1 ELSE 0 END) as ongoing,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
     FROM orders WHERE boss_id = ?`,
    [userId]
  );
  return jsonResponse((result.results && result.results[0]) || { total: 0, pending: 0, ongoing: 0, completed: 0 });
}

async function handleDispatcherOrders(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('无权查看', 403);
  }
  const result = await queryDB(env, 
    'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return jsonResponse(result.results || []);
}

// ============================================================
//  健康检查
// ============================================================
async function handleHealthCheck(env) {
  return jsonResponse({ status: 'ok', time: new Date().toISOString() });
}

// ============================================================
//  入口路由
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
    if (path === '/api/test' && method === 'GET') return jsonResponse({ message: 'OK' });
    if (path === '/api/health' && method === 'GET') return await handleHealthCheck(env);
    if (path === '/api/register' && method === 'POST') return await handleRegister(env, body);
    if (path === '/api/login' && method === 'POST') return await handleLogin(env, body);
    if (path === '/api/products' && method === 'GET') return await handleGetProducts(env, url);
    if (path === '/api/categories' && method === 'GET') return await handleGetCategories(env);
    if (path === '/api/announce' && method === 'GET') return await handleGetAnnounce(env);
    if (path === '/api/handlers' && method === 'GET') return await handleGetHandlers(env);
    if (path.startsWith('/api/categories/') && path.endsWith('/products') && method === 'GET') {
      const categoryId = path.replace('/api/categories/', '').replace('/products', '');
      return await handleGetCategoryProducts(env, categoryId);
    }
    if (path.startsWith('/api/products/') && method === 'GET') {
      const productId = path.replace('/api/products/', '');
      return await handleGetProductDetail(env, productId);
    }

    // 需要登录
    if (path === '/api/me' && method === 'GET') return await handleGetMe(env, authHeader);
    if (path === '/api/orders/my' && method === 'GET') return await handleGetMyOrders(env, authHeader);
    if (path === '/api/orders/buy' && method === 'POST') return await handleBuyProduct(env, authHeader, body);
    if (path === '/api/mails' && method === 'GET') return await handleGetMails(env, authHeader);
    if (path === '/api/tip' && method === 'POST') return await handleSendTip(env, authHeader, body);
    if (path === '/api/dispatcher/stats' && method === 'GET') return await handleDispatcherStats(env, authHeader);
    if (path === '/api/dispatcher/orders' && method === 'GET') return await handleDispatcherOrders(env, authHeader);
    if (path === '/api/dispatcher/products' && method === 'POST') return await handleDispatcherCreateProduct(env, authHeader, body);
    if (path === '/api/dispatcher/publish' && method === 'POST') return await handleDispatcherPublish(env, authHeader, body);
    
    // 充值
    if (path === '/api/recharge/custom' && method === 'POST') return await handleCustomRecharge(env, authHeader, body);
    if (path === '/api/recharge/my' && method === 'GET') return await handleGetMyRecharges(env, authHeader);

    // 客服
    if (path === '/api/service/recharges' && method === 'GET') return await handleGetPendingRecharges(env, authHeader);
    if (path === '/api/service/process' && method === 'POST') return await handleProcessRecharge(env, authHeader, body);
    if (path === '/api/service/users' && method === 'GET') return await handleGetUsersForService(env, authHeader);
    if (path === '/api/service/gift' && method === 'POST') return await handleServiceGift(env, authHeader, body);

    // 消息
    if (path === '/api/messages/send' && method === 'POST') return await handleSendMessage(env, authHeader, body);
    if (path === '/api/messages/contacts' && method === 'GET') return await handleGetContacts(env, authHeader);
    if (path === '/api/messages/users' && method === 'GET') return await handleGetMessageUsers(env, authHeader);
    if (path === '/api/messages/history' && method === 'POST') return await handleGetMessages(env, authHeader, body);
    if (path === '/api/messages/unread' && method === 'GET') return await handleGetUnreadCount(env, authHeader);

    // 带参数的订单接口
    if (path.startsWith('/api/orders/')) {
      const orderId = path.replace('/api/orders/', '');
      if (method === 'GET') return await handleGetOrderDetail(env, authHeader, orderId);
      if (orderId.endsWith('/take')) { const id = orderId.replace('/take', ''); return await handleTakeOrder(env, authHeader, id); }
      if (orderId.endsWith('/submit-complete')) { const id = orderId.replace('/submit-complete', ''); return await handleSubmitComplete(env, authHeader, id); }
      if (orderId.endsWith('/boss-confirm')) { const id = orderId.replace('/boss-confirm', ''); return await handleBossConfirm(env, authHeader, id); }
      if (orderId.endsWith('/refund-request')) { const id = orderId.replace('/refund-request', ''); return await handleRefundRequest(env, authHeader, id, body); }
      if (orderId.endsWith('/chat') && method === 'POST') { const id = orderId.replace('/chat', ''); return await handleSendChat(env, authHeader, id, body); }
      if (orderId.endsWith('/dispatcher-confirm') && method === 'PUT') { const id = orderId.replace('/dispatcher-confirm', ''); return await handleDispatcherConfirmComplete(env, authHeader, id); }
      if (orderId.endsWith('/cancel') && method === 'PUT') { const id = orderId.replace('/cancel', ''); return await handleAdminCancelOrder(env, id); }
    }

    // 邮件领取
    if (path.startsWith('/api/mails/') && path.endsWith('/claim') && method === 'PUT') {
      const mailId = path.replace('/api/mails/', '').replace('/claim', '');
      return await handleClaimMail(env, authHeader, mailId);
    }

    // 管理员接口
    const userId = verifyAndGetUserId(authHeader);
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && user.role === 'admin') {
        if (path === '/api/admin/orders' && method === 'GET') return await handleAdminGetOrders(env);
        if (path === '/api/admin/orders/direct' && method === 'POST') return await handleAdminDirectPublish(env, authHeader, body);
        if (path.startsWith('/api/admin/orders/')) {
          const orderId = path.replace('/api/admin/orders/', '');
          if (orderId.endsWith('/assign') && method === 'PUT') { const id = orderId.replace('/assign', ''); return await handleAdminAssignHandler(env, id, body); }
          if (orderId.endsWith('/force-complete') && method === 'PUT') { const id = orderId.replace('/force-complete', ''); return await handleAdminForceComplete(env, id); }
          if (orderId.endsWith('/confirm') && method === 'PUT') { const id = orderId.replace('/confirm', ''); return await handleAdminConfirm(env, id); }
          if (orderId.endsWith('/reject') && method === 'PUT') { const id = orderId.replace('/reject', ''); return await handleAdminReject(env, id, body); }
          if (orderId.endsWith('/cancel') && method === 'PUT') { const id = orderId.replace('/cancel', ''); return await handleAdminCancelOrder(env, id); }
          if (orderId.endsWith('/settle') && method === 'PUT') { const id = orderId.replace('/settle', ''); return await handleAdminSettle(env, id, body); }
          if (method === 'DELETE') return await handleAdminDeleteOrder(env, orderId);
        }
        if (path === '/api/admin/products' && method === 'GET') return await handleAdminGetProducts(env);
        if (path === '/api/admin/products' && method === 'POST') return await handleAdminCreateProduct(env, body);
        if (path.startsWith('/api/admin/products/')) {
          const productId = path.replace('/api/admin/products/', '');
          if (productId.endsWith('/unshelf') && method === 'PUT') { const id = productId.replace('/unshelf', ''); return await handleAdminUnshelf(env, id); }
          if (productId.endsWith('/reshelf') && method === 'PUT') { const id = productId.replace('/reshelf', ''); return await handleAdminReshelf(env, id); }
          if (productId.endsWith('/edit') && method === 'PUT') { const id = productId.replace('/edit', ''); return await handleAdminUpdateProduct(env, id, body); }
          if (method === 'DELETE') return await handleAdminDeleteProduct(env, productId);
        }
        if (path === '/api/admin/recharges' && method === 'GET') return await handleAdminGetRecharges(env);
        if (path.startsWith('/api/admin/recharges/')) {
          const rechargeId = path.replace('/api/admin/recharges/', '');
          if (rechargeId.endsWith('/approve') && method === 'PUT') { const id = rechargeId.replace('/approve', ''); return await handleAdminApproveRecharge(env, id); }
          if (rechargeId.endsWith('/reject') && method === 'PUT') { const id = rechargeId.replace('/reject', ''); return await handleAdminRejectRecharge(env, id); }
          if (method === 'DELETE') return await handleAdminDeleteRecharge(env, rechargeId);
        }
        if (path === '/api/admin/users' && method === 'GET') return await handleAdminGetUsers(env);
        if (path === '/api/admin/gift' && method === 'POST') return await handleAdminGiftDiamond(env, body);
        if (path.startsWith('/api/admin/users/')) {
          const targetUserId = path.replace('/api/admin/users/', '');
          if (targetUserId.endsWith('/ban') && method === 'PUT') { const id = targetUserId.replace('/ban', ''); return await handleAdminToggleBan(env, id); }
          if (targetUserId.endsWith('/reset-password') && method === 'PUT') { const id = targetUserId.replace('/reset-password', ''); return await handleAdminResetPassword(env, id); }
          if (targetUserId.endsWith('/approve') && method === 'PUT') { const id = targetUserId.replace('/approve', ''); return await handleApproveHandler(env, id); }
          if (targetUserId.endsWith('/username') && method === 'PUT') { const id = targetUserId.replace('/username', ''); return await handleChangeUsername(env, id, body); }
        }
        if (path === '/api/admin/categories' && method === 'POST') return await handleAdminCreateCategory(env, body);
        if (path.startsWith('/api/admin/categories/')) {
          const categoryId = path.replace('/api/admin/categories/', '');
          if (categoryId.endsWith('/edit') && method === 'PUT') { const id = categoryId.replace('/edit', ''); return await handleAdminUpdateCategory(env, id, body); }
          if (method === 'DELETE') return await handleAdminDeleteCategory(env, categoryId);
        }
        if (path === '/api/admin/announce' && method === 'PUT') return await handleAdminUpdateAnnounce(env, body);
      }
    }

    return errorResponse('接口不存在', 404);
  } catch (err) {
    console.error('Pages Functions 错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}