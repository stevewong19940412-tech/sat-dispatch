import { readFileSync } from 'fs';
import { BladeClient } from '@blade-hq/agent-client';
const client = new BladeClient({ baseUrl: 'https://agent.bladeai.com.cn' });
client.setToken(process.env.BLADE_API_TOKEN);

// 从 AgentPane 源码中提取 Solution/Skill 声明——直接内联
const solutionFiles = [
  { path: "solution.yaml", content: `id: sat-dispatch-assistant
name: 遥感卫星任务下单助手
manifest_version: 3
version: 0.1.0
layout_type: default
initial_mode: executing
initial_message: 请描述您的遥感观测需求
skill_tools_enabled: true
roles:
  - dispatch-agent
` },
  { path: "roles/dispatch-agent/role.yaml", content: `id: dispatch-agent
name: 遥感任务下单专员
version: 0.1.0
description: 把用户的观测需求解析为标准任务单，驱动候选计算与派单
layout_type: default
initial_mode: executing
` },
  { path: "roles/dispatch-agent/AGENTS.md.j2", content: readFileSync('client/public/agent/role_prompt.md', 'utf-8') },
];
const skillFiles = [{ path: "SKILL.md", content: readFileSync('client/public/agent/skill_dispatch_ops.md', 'utf-8') }];

console.log('创建正式会话...');
const created = await client.sessions.create({
  solution: { role: "dispatch-agent", files: solutionFiles },
  skills: [{ name: "my/dispatch-ops", files: skillFiles }],
  config: { model: "deepseek-4.1-flash" },
});
console.log('SESSION_OK:', created.sessionId);
const result = await client.headless.runInSession(created.sessionId,
  '我要对上海洋山港做一次光学成像，分辨率1米，明天全天都可以，云量要求30%以内。请帮我下单并走调度流程',
  { timeoutMs: 300000 });
console.log('=== 助手回复 ===');
console.log(typeof result === 'string' ? result.slice(0, 1500) : JSON.stringify(result).slice(0, 1500));
process.exit(0);
