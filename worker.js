// worker.js - 后端 API 代理
const BACKEND_URL = 'https://qw-esports-backend.vercel.app/api';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 转发 /api 请求到 Vercel 后端
    if (url.pathname.startsWith('/api')) {
      const targetUrl = BACKEND_URL + url.pathname + url.search;
      const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      const response = await fetch(newRequest);
      const newResponse = new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return newResponse;
    }

    return new Response('API Proxy', { status: 200 });
  }
};