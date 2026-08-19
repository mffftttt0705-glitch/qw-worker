// ============================================================
//  QW电竞 - 完整后端（Cloudflare D1 版本）
// ============================================================

// ===== 工具函数 =====
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
//  D1 数据库操作
// ============================================================
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
//  业务函数
// ============================================================

// 注册
async function handleRegister(env, body) {
  const { username, password, role } = body;
  if (!username || !password) {
    return errorResponse('请填写用户名和密码');
  }

  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已存在');
  }

  const id = generateId();
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, status) VALUES (?, ?, ?, ?, 0, 0, "active")',
    [id, username, password, role || 'boss']
  );

  return jsonResponse({ message: '注册成功', id });
}

// 登录
async function handleLogin(env, body) {
  const { username, password } = body;
  if (!username || !password) {
    return errorResponse('请填写用户名和密码');
  }

  const result = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  const user = result.results ? result.results[0] : null;
  if (!user) {
    return errorResponse('用户不存在');
  }
  if (user.password !== password) {
    return errorResponse('密码错误');
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

// 获取商品列表
async function handleGetProducts(env) {
  const result = await queryDB(env, 'SELECT * FROM products WHERE hidden = 0 ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

// 获取公告
async function handleGetAnnounce(env) {
  const result = await queryDB(env, 'SELECT * FROM announces ORDER BY updated_at DESC LIMIT 1');
  const data = (result.results && result.results[0]) || { content: '欢迎使用 QW电竞护航平台！', images: '[]' };
  return jsonResponse(data);
}

// ============================================================
//  获取用户
// ============================================================
async function getUserById(env, userId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  return (result.results && result.results[0]) || null;
}

// ============================================================
//  主入口
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    let body = {};
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch (e) {}

    // OPTIONS 预检
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
      // ===== 公开接口 =====
      if (path === '/api/login' && method === 'POST') {
        return await handleLogin(env, body);
      }
      if (path === '/api/register' && method === 'POST') {
        return await handleRegister(env, body);
      }
      if (path === '/api/products' && method === 'GET') {
        return await handleGetProducts(env);
      }
      if (path === '/api/announce' && method === 'GET') {
        return await handleGetAnnounce(env);
      }

      // ===== 验证 Token =====
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) {
        return errorResponse('请先登录', 401);
      }
      const parts = authHeader.split('.');
      if (parts.length !== 2) {
        return errorResponse('无效token', 401);
      }
      const userId = parts[1];
      const user = await getUserById(env, userId);
      if (!user) {
        return errorResponse('用户不存在', 401);
      }

      // ===== 获取个人信息 =====
      if (path === '/api/me' && method === 'GET') {
        const { password, ...rest } = user;
        return jsonResponse(rest);
      }

      // ===== 获取我的订单 =====
      if (path === '/api/orders/my' && method === 'GET') {
        let sql = '';
        if (user.role === 'boss') {
          sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
        } else if (user.role === 'handler') {
          sql = 'SELECT * FROM orders WHERE handler_id = ? ORDER BY created_at DESC';
        } else {
          return errorResponse('无权查看', 403);
        }
        const result = await queryDB(env, sql, [userId]);
        return jsonResponse(result.results || []);
      }

      // ===== 购买商品 =====
      if (path === '/api/orders/buy' && method === 'POST') {
        const { productId } = body;
        if (!productId) return errorResponse('请选择商品');

        const prodResult = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
        const product = (prodResult.results && prodResult.results[0]) || null;
        if (!product) return errorResponse('商品不存在', 404);
        if (product.quantity <= product.sold) return errorResponse('库存不足');

        const diamondCost = product.price * 10;
        if (user.diamond < diamondCost) return errorResponse('红钻不足');

        await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);

        const orderId = generateId();
        await runDB(env,
          'INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, ?, "pending", ?, ?, ?, ?, ?)',
          [orderId, productId, userId, product.price, product.game, product.title, product.desc || '', JSON.stringify([{ sender: 'system', content: '🎉 订单已创建', time: new Date() }])]
        );

        await runDB(env, 'UPDATE products SET sold = sold + 1 WHERE id = ?', [productId]);
        return jsonResponse({ orderId, message: '购买成功' });
      }

      // ===== 打手接单 =====
      if (path.startsWith('/api/orders/') && path.endsWith('/take') && method === 'PUT') {
        if (user.role !== 'handler') return errorResponse('只有打手可接单');
        const orderId = path.replace('/api/orders/', '').replace('/take', '');
        const orderResult = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
        const order = (orderResult.results && orderResult.results[0]) || null;
        if (!order) return errorResponse('订单不存在', 404);
        if (order.status !== 'pending') return errorResponse('订单不可接');
        await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?', [userId, new Date().toISOString(), orderId]);
        return jsonResponse({ message: '接单成功' });
      }

      // ===== 打手提交完成 =====
      if (path.startsWith('/api/orders/') && path.endsWith('/submit-complete') && method === 'PUT') {
        if (user.role !== 'handler') return errorResponse('只有打手可操作');
        const orderId = path.replace('/api/orders/', '').replace('/submit-complete', '');
        const orderResult = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
        const order = (orderResult.results && orderResult.results[0]) || null;
        if (!order) return errorResponse('订单不存在', 404);
        if (order.handler_id !== userId) return errorResponse('不是你的订单', 403);
        if (order.status !== 'ongoing') return errorResponse('只有进行中可提交');
        await runDB(env, 'UPDATE orders SET status = "review" WHERE id = ?', [orderId]);
        return jsonResponse({ message: '已提交验收' });
      }

      // ===== 老板确认完成 =====
      if (path.startsWith('/api/orders/') && path.endsWith('/boss-confirm') && method === 'PUT') {
        if (user.role !== 'boss') return errorResponse('只有老板可操作');
        const orderId = path.replace('/api/orders/', '').replace('/boss-confirm', '');
        const orderResult = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
        const order = (orderResult.results && orderResult.results[0]) || null;
        if (!order) return errorResponse('订单不存在', 404);
        if (order.boss_id !== userId) return errorResponse('不是你的订单', 403);
        if (order.status !== 'review') return errorResponse('只有待验收可确认');
        await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
        return jsonResponse({ message: '已确认完成，等待管理员结算' });
      }

      // ===== 申请退款 =====
      if (path.startsWith('/api/orders/') && path.endsWith('/refund-request') && method === 'PUT') {
        if (user.role !== 'boss') return errorResponse('只有老板可发起退款');
        const orderId = path.replace('/api/orders/', '').replace('/refund-request', '');
        const { reason } = body;
        if (!reason) return errorResponse('请填写退款原因');
        const orderResult = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
        const order = (orderResult.results && orderResult.results[0]) || null;
        if (!order) return errorResponse('订单不存在', 404);
        if (order.boss_id !== userId) return errorResponse('不是你的订单', 403);
        if (order.status === 'completed') return errorResponse('已完成订单不可退款');
        if (order.status === 'refunded' || order.status === 'refund_pending') return errorResponse('已处理退款');
        await runDB(env, 'UPDATE orders SET status = "refund_pending", refund_reason = ? WHERE id = ?', [reason, orderId]);
        return jsonResponse({ success: true, message: '退款申请已提交' });
      }

      // ============================================================
      //  管理员接口
      // ============================================================
      if (user.role === 'admin') {
        // 获取所有订单
        if (path === '/api/admin/orders' && method === 'GET') {
          const result = await queryDB(env, 'SELECT * FROM orders ORDER BY created_at DESC');
          return jsonResponse(result.results || []);
        }
        // 获取所有用户
        if (path === '/api/admin/users' && method === 'GET') {
          const result = await queryDB(env, 'SELECT id, username, role, diamond, balance, status FROM users');
          return jsonResponse(result.results || []);
        }
        // 获取所有商品
        if (path === '/api/admin/products' && method === 'GET') {
          const result = await queryDB(env, 'SELECT * FROM products ORDER BY created_at DESC');
          return jsonResponse(result.results || []);
        }
        // 上架商品
        if (path === '/api/admin/products' && method === 'POST') {
          const { game, title, description, price, quantity } = body;
          if (!title || !price) return errorResponse('请填写完整信息');
          const id = generateId();
          await runDB(env,
            'INSERT INTO products (id, game, title, description, price, quantity, sold, hidden) VALUES (?, ?, ?, ?, ?, 0, 0)',
            [id, game || '暗区突围', title, description || '', parseFloat(price), parseInt(quantity) || 1]
          );
          return jsonResponse({ success: true, id });
        }
        // 下架商品
        if (path.startsWith('/api/admin/products/') && path.endsWith('/unshelf') && method === 'PUT') {
          const productId = path.replace('/api/admin/products/', '').replace('/unshelf', '');
          await runDB(env, 'UPDATE products SET hidden = 1 WHERE id = ?', [productId]);
          return jsonResponse({ success: true, message: '已下架' });
        }
        // 重新上架
        if (path.startsWith('/api/admin/products/') && path.endsWith('/reshelf') && method === 'PUT') {
          const productId = path.replace('/api/admin/products/', '').replace('/reshelf', '');
          await runDB(env, 'UPDATE products SET hidden = 0 WHERE id = ?', [productId]);
          return jsonResponse({ success: true, message: '已重新上架' });
        }
        // 删除商品
        if (path.startsWith('/api/admin/products/') && method === 'DELETE') {
          const productId = path.replace('/api/admin/products/', '');
          await runDB(env, 'DELETE FROM products WHERE id = ?', [productId]);
          return jsonResponse({ success: true, message: '已删除' });
        }
        // 指派打手
        if (path.startsWith('/api/admin/orders/') && path.endsWith('/assign') && method === 'PUT') {
          const orderId = path.replace('/api/admin/orders/', '').replace('/assign', '');
          const { handlerId } = body;
          if (!handlerId) return errorResponse('请选择打手');
          await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?', [handlerId, new Date().toISOString(), orderId]);
          return jsonResponse({ message: '指派成功' });
        }
        // 强制完成
        if (path.startsWith('/api/admin/orders/') && path.endsWith('/force-complete') && method === 'PUT') {
          const orderId = path.replace('/api/admin/orders/', '').replace('/force-complete', '');
          await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
          return jsonResponse({ message: '强制完成成功' });
        }
        // 确认验收
        if (path.startsWith('/api/admin/orders/') && path.endsWith('/confirm') && method === 'PUT') {
          const orderId = path.replace('/api/admin/orders/', '').replace('/confirm', '');
          await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
          return jsonResponse({ message: '验收通过' });
        }
        // 驳回订单
        if (path.startsWith('/api/admin/orders/') && path.endsWith('/reject') && method === 'PUT') {
          const orderId = path.replace('/api/admin/orders/', '').replace('/reject', '');
          const { reason } = body;
          await runDB(env, 'UPDATE orders SET status = "rejected", refund_reason = ? WHERE id = ?', [reason || '无原因', orderId]);
          return jsonResponse({ message: '已驳回' });
        }
        // 取消订单
        if (path.startsWith('/api/admin/orders/') && path.endsWith('/cancel') && method === 'PUT') {
          const orderId = path.replace('/api/admin/orders/', '').replace('/cancel', '');
          const orderResult = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
          const order = (orderResult.results && orderResult.results[0]) || null;
          await runDB(env, 'UPDATE orders SET status = "canceled" WHERE id = ?', [orderId]);
          if (order && order.boss_id) {
            await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price * 10, order.boss_id]);
          }
          return jsonResponse({ message: '已取消' });
        }
        // 直接发布订单
        if (path === '/api/admin/orders/direct' && method === 'POST') {
          const { game, title, description, price } = body;
          if (!title || !price) return errorResponse('请填写完整信息');
          const orderId = generateId();
          await runDB(env,
            'INSERT INTO orders (id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, "pending", ?, ?, ?, ?, ?)',
            [orderId, userId, parseFloat(price), game || '暗区突围', title, description || '', JSON.stringify([{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date() }])]
          );
          return jsonResponse({ success: true, orderId });
        }
        // 结算
        if (path.startsWith('/api/admin/orders/') && path.endsWith('/settle') && method === 'PUT') {
          const orderId = path.replace('/api/admin/orders/', '').replace('/settle', '');
          const { earning } = body;
          const amount = parseFloat(earning);
          if (isNaN(amount) || amount < 0) return errorResponse('金额无效');
          const orderResult = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
          const order = (orderResult.results && orderResult.results[0]) || null;
          if (!order) return errorResponse('订单不存在', 404);
          if (order.settled) return errorResponse('已结算');
          if (order.status !== 'completed') return errorResponse('只有已完成订单可结算');
          if (order.handler_id) {
            await runDB(env, 'UPDATE users SET balance = balance + ? WHERE id = ?', [amount, order.handler_id]);
          }
          await runDB(env, 'UPDATE orders SET settled = 1, settled_amount = ? WHERE id = ?', [amount, orderId]);
          return jsonResponse({ success: true, message: `结算成功 ¥${amount}` });
        }
      }

      return errorResponse('接口不存在', 404);

    } catch (err) {
      console.error('Error:', err);
      return errorResponse(err.message || '服务器错误', 500);
    }
  }
};