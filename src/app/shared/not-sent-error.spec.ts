import { notSentError } from './not-sent-error';

describe('notSentError', () => {
  it('is a retry banner that carries its own title and detail', () => {
    expect(notSentError()).toEqual({
      kind: 'retry',
      title: 'That was not sent.',
      detail: 'You are signed in again. Press the button once more to send it.',
    });
  });
});
