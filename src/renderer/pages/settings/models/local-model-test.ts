import { toLocalModelApiName as toApiName } from '../../../../main/llm/model-names';

export const LOCAL_MODEL_TEST_TIMEOUT_MS = 120_000;

export function toLocalModelApiName(modelName: string): string {
  return toApiName(modelName);
}

export function shouldRestartLocalServerAfterTest(testedModel: string, selectedModel: string): boolean {
  return testedModel !== selectedModel;
}

export function getLocalModelTestButtonClass(modelName: string, recentlyTested: string | null, localTesting: boolean): string {
  const classes = ['kz-btn', 'kz-btn--sm'];

  if (recentlyTested === modelName && !localTesting) {
    classes.push('kz-btn--success');
  }

  if (localTesting) {
    classes.push('opacity-50');
  }

  return classes.join(' ');
}
