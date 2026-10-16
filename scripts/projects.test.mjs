import test from 'node:test';
import assert from 'node:assert/strict';
import { rankProjects, projectDescription } from './projects.mjs';

const repo = (name, stars = 0, forks = 0, pushedAt = '2026-10-01') => ({name,stargazerCount:stars,forkCount:forks,pushedAt});

test('stars take priority over forks, then forks and update date break ties', () => {
  const input = [repo('recent',0,0,'2026-10-16'),repo('forks',0,3),repo('stars',1),repo('older',0,0,'2026-09-01')];
  assert.deepEqual(rankProjects(input,'owner').map(r=>r.name),['stars','forks','recent','older']);
  assert.equal(input[0].name,'recent');
});
test('a new project enters the ranking without config or manual pins', () => {
  const input = [repo('owner',100),{...repo('archived',80),isArchived:true},repo('existing',2),{...repo('new-fork',3),isFork:true}];
  assert.deepEqual(rankProjects(input,'Owner').map(r=>r.name),['new-fork','existing']);
  assert.deepEqual(rankProjects(input.filter(r=>r.name!=='new-fork'),'Owner').map(r=>r.name),['existing']);
});
test('equal rankings have a stable order independent of API order', () => {
  assert.deepEqual(rankProjects([repo('z'),repo('a')],'owner').map(r=>r.name),['a','z']);
});
test('live English descriptions replace stale text and bilingual descriptions stay English', () => {
  assert.equal(projectDescription({...repo('tool'),description:'Updated description.'},{description:'Old description.'}),'Updated description.');
  assert.equal(projectDescription({...repo('tool'),description:'Windows tools. 移动硬盘工具'}),'Windows tools.');
  assert.equal(projectDescription({...repo('tool'),description:'工具'},{description:'English fallback.'}),'English fallback.');
  assert.match(projectDescription(repo('new')),/Explore the source code/);
});
