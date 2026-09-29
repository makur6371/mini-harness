# 部署 mini-harness

最小 Agent 上公网的三种方式。选一种,把 `https://your-host` 换成你的域名即可。

## 0. 准备:配 LLM key 与站点 token

站点 token 写进 `data/<site>/config.json`(不进仓库),例如:

```json
{ "tokens": ["sek-放一串随机串"] }
```

模型 key 走环境变量:`MINI_LLM_API_KEY`、`MINI_LLM_BASE_URL`(默认 DeepSeek)、`MINI_LLM_MODEL`。

## A. Fly.io(最快,免费层够 demo)

```bash
# 装一次 flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly launch --no-detach        # 用仓库里的 fly.toml
fly secrets set MINI_LLM_API_KEY=sk-xxx
fly deploy
# 得到 https://mini-harness.fly.dev
```

## B. 任意服务器 + Docker

```bash
docker build -t mini-harness .
docker run -d -p 8787:8787 \
  -e MINI_LLM_API_KEY=sk-xxx \
  -v $(pwd)/data:/app/data \
  mini-harness
```

## C. 裸机 + systemd + nginx(已有 VPS)

```bash
# 1) 跑服务(建议用 pm2 或 systemd)
sudo cp deploy/mini-harness.service /etc/systemd/system/
sudo systemctl enable --now mini-harness
# 2) nginx 反代 + HTTPS(见 deploy/nginx.conf)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mini-harness
sudo ln -s /etc/nginx/sites-available/mini-harness /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-host   # 自动上 HTTPS
sudo nginx -t && sudo systemctl reload nginx
```

## 接入客户网站(一行)

部署后,在客户网页底部加:

```html
<script src="https://your-host/embed.js"
        data-site="demo-clinic"
        data-token="sek-放一串随机串"
        defer></script>
```

`deploy/customer-site.html` 是一个最小宿主页示例,可直接本地打开看效果(把 host 改成你的)。

## 安全提醒

- `data-token` 在页面源码里可见(同 Google Maps key 的固有局限);真正的防刷靠
  **token + 限流(已内置 20/分钟)+ Origin 白名单**三层组合,别把 token 当密钥。
- 大客户建议独立进程 + 独立 key + 独立域名,见 README 的"生产化还差什么"。
