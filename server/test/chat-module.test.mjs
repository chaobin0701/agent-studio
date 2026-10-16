import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatModule } from '../dist/chat/chat.module.js';
import { SkillsModule } from '../dist/ai/skills/skills.module.js';

test('chat orchestrator can resolve the on-demand SkillRegistry through a directly imported module',()=>{
  assert.ok(Reflect.getMetadata('imports',ChatModule).includes(SkillsModule));
});
