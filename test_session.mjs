import { BladeClient } from '@blade-hq/agent-client';
const client = new BladeClient({ baseUrl: 'https://agent.bladeai.com.cn' });
client.setToken(process.env.BLADE_API_TOKEN);
const solutionFiles = [
  { path: "solution.yaml", content: `id: sat-dispatch-test\nname: 调度测试\nmanifest_version: 3\nversion: 0.1.0\nlayout_type: default\ninitial_mode: executing\nskill_tools_enabled: true\nroles:\n  - test-role\n` },
  { path: "roles/test-role/role.yaml", content: `id: test-role\nname: 测试角色\nversion: 0.1.0\nlayout_type: default\ninitial_mode: executing\n` },
  { path: "roles/test-role/AGENTS.md.j2", content: `# 测试\n你是调度系统测试助手。` },
];
console.log('开始创建...');
const created = await client.sessions.create({
  solution: { role: "test-role", files: solutionFiles },
  skills: [{ name: "my/test-ops", files: [{ path: "SKILL.md", content: "---\nname: test-ops\ndescription: 测试\n---\n# 测试" }] }],
  config: { model: "deepseek-4.1-flash" },
});
console.log('SESSION_OK:', created.sessionId);
process.exit(0);
