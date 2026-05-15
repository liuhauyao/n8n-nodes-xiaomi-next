/**
 * 校验根目录 package.json；本包为 LangChain AI 运行时依赖模型，豁免部分规则。
 */
import { ESLint } from 'eslint';
import { defineConfig } from 'eslint/config';
import pluginPkg from '@n8n/eslint-plugin-community-nodes';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rec = pluginPkg.configs.recommendedWithoutN8nCloudSupport;

const eslint = new ESLint({
	cwd: root,
	allowInlineConfig: false,
	overrideConfigFile: true,
	overrideConfig: defineConfig(
		rec,
		{
			rules: {
				'@n8n/community-nodes/no-runtime-dependencies': 'off',
				'@n8n/community-nodes/no-forbidden-lifecycle-scripts': 'off',
			},
		},
	),
});

const results = await eslint.lintFiles([join(root, 'package.json')]);
const errCount = results.reduce((n, r) => n + r.errorCount + r.fatalErrorCount, 0);
if (errCount > 0) {
	const formatter = await eslint.loadFormatter('stylish');
	process.stdout.write(await formatter.format(results));
	process.exit(1);
}
