import { BladeClient } from '@blade-hq/agent-client';
const client = new BladeClient({ baseUrl: 'https://agent.bladeai.com.cn' });
client.setToken(process.env.BLADE_API_TOKEN);
const result = await client.headless.runInSession(process.argv[2], '请用 dispatch tasks 命令查询当前有哪些调度任务，然后用一句中文汇报结果', { timeoutMs: 220000 });
console.log('=== 运行结果 ===');
console.log(typeof result === 'string' ? result.slice(0, 800) : JSON.stringify(result, null, 1).slice(0, 800));
process.exit(0);
