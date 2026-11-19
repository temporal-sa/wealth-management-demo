// The Gemini model setting (gemini.ts): the workflows ask for GEMINI_MODEL_ALIAS and the worker's
// provider turns it into GEMINI_MODEL.
import assert from 'assert';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL_ALIAS, geminiModel, geminiProvider } from '../gemini';

describe('Gemini model', () => {
  const saved = process.env.GEMINI_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = saved;
  });

  it('defaults to DEFAULT_GEMINI_MODEL', () => {
    assert.strictEqual(geminiModel({}), DEFAULT_GEMINI_MODEL);
    assert.strictEqual(geminiModel({ GEMINI_MODEL: '' }), DEFAULT_GEMINI_MODEL);
  });

  it('reads GEMINI_MODEL', () => {
    assert.strictEqual(geminiModel({ GEMINI_MODEL: 'gemini-3.8-pro' }), 'gemini-3.8-pro');
  });

  it("maps the workflows' model name to GEMINI_MODEL in the worker's provider", () => {
    process.env.GEMINI_MODEL = 'gemini-3.8-pro';
    const model = geminiProvider().languageModel(GEMINI_MODEL_ALIAS);
    assert.strictEqual(typeof model === 'string' ? model : model.modelId, 'gemini-3.8-pro');
  });

  it('passes any other model name through', () => {
    const model = geminiProvider().languageModel('gemini-2.5-pro');
    assert.strictEqual(typeof model === 'string' ? model : model.modelId, 'gemini-2.5-pro');
  });
});
