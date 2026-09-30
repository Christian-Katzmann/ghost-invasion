// Writes a deterministic, unapproved example; edit routes/inputs/assertions before authorizing.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localOrigin } from '../core/dist/local-boundary.js';
const [projectDirectory, baseUrl] = process.argv.slice(2);
if (!projectDirectory || !baseUrl) throw new Error('Usage: node prepare-local-plan.mjs <project-directory> <http://127.0.0.1:port>');
localOrigin(baseUrl);
const projectRoot = resolve(projectDirectory);
const plan = JSON.parse(await readFile(new URL('./local-plan-template.json', import.meta.url), 'utf8'));
plan.target.baseUrl = baseUrl;
plan.createdAt = new Date().toISOString();
await mkdir(join(projectRoot, '.ghost/plan'), { recursive: true });
const path = join(projectRoot, '.ghost/plan/ghost-invasion-plan.json');
await writeFile(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path, approved: false, next: 'Adapt journeys and assertions to the disposable application, then explicitly authorize target and reset endpoint.' }));
