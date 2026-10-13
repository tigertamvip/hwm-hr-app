// Supabase 反向代理（EdgeOne Pages Edge Function）
// 作用：国内网络对 *.supabase.co 的 TLS 连接被重置，导致登录/数据同步全部失败。
// 通过 EdgeOne 边缘节点中转：客户端请求 https://hwm.tiger-buddy.com/sb/* → 转发到 Supabase 项目。
// 路由：/sb/rest/v1/xxx → {UPSTREAM}/rest/v1/xxx（其余路径原样透传，含 query string）

const UPSTREAM = 'https://xgysfujnhwgevmojzkbf.supabase.co';

export default async function onRequest(context) {
  const req = context.request;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/sb/, '') || '/';
  const target = UPSTREAM + path + url.search;

  // 透传请求头（apikey / Authorization / Content-Type / Prefer 等），去掉 host
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('Host');

  const hasBody = !(req.method === 'GET' || req.method === 'HEAD');
  let upstreamResp;
  try {
    upstreamResp = await fetch(target, {
      method: req.method,
      headers: headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'supabase-proxy-upstream-failed', message: String(e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }

  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Headers', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS');
  respHeaders.delete('content-encoding'); // 避免边缘节点二次压缩冲突
  respHeaders.delete('Content-Encoding');

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
}
