// sites/demo-shop.site.mjs — 第二个垂直站点包:数码电商官网
// 与诊所包共用同一套钩子协议,不改动任何内核/server 代码 —— 这就是泛化性验证。

export default async function install(ctx, env) {
  // 1. 身份与规则
  ctx.prompt.register({
    id: 'shop-identity',
    priority: 0,
    text: `你是"极客严选"数码电商的购物顾问小极。
职责:商品咨询、比价推荐、查优惠、下单留资。
风格:专业不啰嗦,报价精确到元,先问需求再推商品。`,
  });
  ctx.prompt.register({
    id: 'shop-rules',
    priority: 10,
    text: `规则:
- 只讨论本店在售的 3C 数码品类;盗版/刷单/外部渠道比价一律不谈。
- 推荐时先问预算和用途,再查库存报价;一次最多推荐 3 款。
- 下单前必须确认:型号、颜色、收货手机号;然后调用 create_order。`,
  });

  // 2. 垂直工具
  const STOCK = {
    '机械键盘 K87': { price: 329, color: ['黑', '白'], stock: 12 },
    '降噪耳机 Q2': { price: 899, color: ['黑'], stock: 5 },
    '4K 显示器 27X': { price: 1899, color: ['黑'], stock: 0 },
  };
  ctx.tools.register({
    id: 'query_product',
    description: '按关键词查询在售商品的价格、颜色与库存。',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '商品关键词,如 键盘' } },
      required: ['keyword'],
    },
    async execute({ keyword }) {
      return Object.entries(STOCK)
        .filter(([name]) => name.includes(keyword))
        .map(([name, v]) => ({
          商品: name,
          价格: `${v.price} 元`,
          颜色: v.color.join('/'),
          库存: v.stock > 0 ? `有货(${v.stock})` : '缺货',
        }));
    },
  });

  ctx.tools.register({
    id: 'create_order',
    description: '创建订单(留资)。必须已确认型号、颜色、收货手机号后才能调用。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: '商品全名' },
        color: { type: 'string', description: '颜色' },
        phone: { type: 'string', description: '11 位收货手机号' },
      },
      required: ['product', 'color', 'phone'],
    },
    async execute(args) {
      if (!/^1\d{10}$/.test(args.phone)) throw new Error('手机号格式不对,请向访客确认 11 位手机号');
      const item = STOCK[args.product];
      if (!item) throw new Error(`没有商品 "${args.product}",请用 query_product 查准确名称`);
      if (!item.color.includes(args.color))
        throw new Error(`"${args.product}" 没有 ${args.color} 色,可选:${item.color.join('/')}`);
      if (item.stock <= 0) throw new Error(`"${args.product}" 缺货中,建议推荐其他款`);
      item.stock -= 1;
      const id = 'SO' + Date.now().toString(36).toUpperCase().slice(-6);
      ctx.store.set(`order:${id}`, { ...args, amount: item.price, createdAt: Date.now(), status: 'pending' });
      return { ok: true, 订单号: id, 金额: `${item.price} 元`, 提示: '客服会短信确认收货地址。' };
    },
  });

  // 3. 兜底 + 守门(演示 before:chat)
  ctx.on('before:chat', (p) => {
    // 示例:带"退款"字样的直接转人工,不进模型
    if (/退款/.test(p.message))
      p.reject = '退款事务由人工专属客服处理,请拨打 400-111-2222 或留下手机号,我们会尽快联系你。';
  });
  ctx.on('after:final', (out) => {
    if (!out.content || !out.content.trim())
      out.content = '这个问题我帮你转人工啦,也可以直接联系在线客服~';
  });

  // 4. 前端呈现
  ctx.embed = {
    title: '极客严选 · 小极',
    welcome: '你好,我是小极 🎧 想找键盘、耳机还是显示器?说说预算我帮你挑~',
    theme: { accent: '#16a34a' },
    tokens: env.config.tokens ?? [],
  };
}
