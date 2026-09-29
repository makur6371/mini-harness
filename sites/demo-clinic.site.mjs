// sites/demo-clinic.site.mjs — 垂直站点插件包示例:某连锁口腔诊所官网
//
// 这就是"垂直化"的全部:一个文件。内核与 server 零改动。
// 同一个包同时塑造四件事:
//   1. 模型看到什么(prompt 注入身份与规则)
//   2. 模型能用什么(只注册两个咨询/办事工具,绝不挂 bash)
//   3. 收不了场怎么办(兜底话术)
//   4. 访客看到什么(标题/欢迎语/主题色)

export default async function install(ctx, env) {
  // —— 1. 身份注入:走缝3,不碰内核 ——
  ctx.prompt.register({
    id: 'clinic-identity',
    priority: 0,
    text: `你是"皓齿口腔"官网的接待助手小皓。
你的职责:解答诊疗项目、价格区间、医生排班问题;帮访客提交预约挂号。
语气亲切简洁,用中文,回复控制在 3 句话以内。`,
  });
  ctx.prompt.register({
    id: 'clinic-rules',
    priority: 10,
    text: `规则:
- 只回答口腔诊疗相关问题;医疗诊断类问题一律建议线下面诊,不得给出诊断或用药建议。
- 价格只报区间(以 tools 里的价目为准),最终以门店确认为准。
- 需要预约时,先问清:姓名、手机号、想约的项目与日期,然后调用 book_appointment。`,
  });

  // —— 2. 垂直工具:访客形态只给白名单里的几个,这是与开发者形态(bash)最大的区别 ——
  ctx.tools.register({
    id: 'query_services',
    description: '查询诊所的诊疗项目与价格区间。访客问价格/项目时调用。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return [
        { 项目: '超声波洁牙', 价格: '199-299 元', 时长: '约 40 分钟' },
        { 项目: '树脂补牙', 价格: '300-600 元/颗', 时长: '约 30 分钟' },
        { 项目: '隐形矫正', 价格: '19800-39800 元', 时长: '疗程 12-24 个月' },
        { 项目: '种植牙(单颗)', 价格: '6800-15800 元', 时长: '分 2-3 次就诊' },
      ];
    },
  });

  ctx.tools.register({
    id: 'book_appointment',
    description: '提交预约挂号。必须已拿到访客的姓名、手机号、项目与日期后才能调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '访客姓名' },
        phone: { type: 'string', description: '11 位手机号' },
        service: { type: 'string', description: '项目名,如 超声波洁牙' },
        date: { type: 'string', description: '希望就诊日期,如 2025-10-08 或 明天下午' },
      },
      required: ['name', 'phone', 'service', 'date'],
    },
    async execute(args) {
      if (!/^1\d{10}$/.test(args.phone)) throw new Error('手机号格式不对,请向访客确认 11 位手机号');
      const id = 'BK' + Date.now().toString(36).toUpperCase().slice(-6);
      // 持久化走缝4(ctx.store),站点包不自己管文件
      ctx.store.set(`appointment:${id}`, { ...args, createdAt: Date.now(), status: 'pending' });
      return { ok: true, 预约号: id, 提示: '预约已提交,门店会在 2 小时内短信确认。' };
    },
  });

  // —— 3. 兜底:走事件缝(handler 直接修改 payload,返回值无效)——
  ctx.on('after:final', (out) => {
    if (!out.content || !out.content.trim())
      out.content = '这个问题我需要转人工确认,稍后会有顾问联系你,也可以拨打 400-000-0000。';
  });

  // 4. 前端呈现:embed.json 会读这里;tokens 从 config.json 注入(不进仓库)
  ctx.embed = {
    title: '皓齿口腔 · 小皓',
    welcome: '你好,我是小皓 🦷 想了解项目价格或预约挂号,直接说就行~',
    theme: { accent: '#0ea5e9' },
    tokens: env.config.tokens ?? [],
  };
}
