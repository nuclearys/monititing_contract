import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeepSeekContent } from '../src/modules/ai/deepseek.ts';

test('DeepSeek response parser normalizes the supported obligation shape', () => {
  const obligations = parseDeepSeekContent(`\n    \`\`\`json
    {"obligations":[
      {"subject":"Оплатить поставку","obligation_type":"financial","amount":150000,"confidence":0.91},
      {"title":"Передать документы","obligationType":"non_financial","dueDate":"2026-11-15","sourceFragment":"пункт 2.1"},
      {"description":"Строка без названия"}
    ]}
    \`\`\`
  `);

  assert.equal(obligations.length, 2);
  assert.deepEqual(obligations[0], {
    title: 'Оплатить поставку',
    description: null,
    responsibleParty: null,
    dueDate: null,
    obligationType: 'financial',
    sanction: null,
    riskLevel: null,
    confidence: 0.91,
    sourceFragment: null,
    amount: 150000,
    currency: null,
  });
  assert.equal(obligations[1].obligationType, 'non_financial');
  assert.equal(obligations[1].dueDate, '2026-11-15');
});

test('DeepSeek response parser rejects malformed JSON', () => {
  assert.throws(() => parseDeepSeekContent('{not-json}'), SyntaxError);
});
