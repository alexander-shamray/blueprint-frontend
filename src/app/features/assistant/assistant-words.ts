import { ConversationProblem } from '@core/assistant/assistant-client';
import { TurnEndReason } from '@core/assistant/protocol';

/**
 * The panel's words for the protocol's codes. The protocol carries no prose of
 * its own (AI assistant design §5.4): a tool call is a name and a few
 * arguments, a turn's end a reason, a failure a code, and each client words
 * them in its own language. These are this client's, marked like every other
 * message (`docs/client-architecture.md` §17).
 */

/**
 * A tool call as the customer reads it while it runs, by the tool's name: the
 * BFF's three reads (`Web.Bff/Assistant/CustomerReadTools.cs`) and this
 * client's four views (`shop-tools.ts`). A tool this client does not know is
 * still a call the customer sees, under a general word.
 */
export function toolLabel(name: string, args: Readonly<Record<string, unknown>>): string {
  switch (name) {
    case 'list_orders':
      return $localize`:@@assistant.tool.listOrders:Reading your orders`;
    case 'get_order':
      return $localize`:@@assistant.tool.getOrder:Reading an order`;
    case 'get_product':
      return $localize`:@@assistant.tool.getProduct:Looking up a product`;
    case 'open_product':
      return $localize`:@@assistant.tool.openProduct:Opening a product`;
    case 'open_order':
      return $localize`:@@assistant.tool.openOrder:Opening an order`;
    case 'open_cart':
      return $localize`:@@assistant.tool.openCart:Opening your cart`;
    case 'open_page':
      return pageLabel(args['page']);
    default:
      return $localize`:@@assistant.tool.other:Working on it`;
  }
}

function pageLabel(page: unknown): string {
  switch (page) {
    case 'products':
      return $localize`:@@assistant.tool.openProducts:Opening the products`;
    case 'orders':
      return $localize`:@@assistant.tool.openOrders:Opening your order history`;
    case 'account':
      return $localize`:@@assistant.tool.openAccount:Opening your account`;
    case 'publish':
      return $localize`:@@assistant.tool.openPublish:Opening Publish`;
    default:
      return $localize`:@@assistant.tool.openPage:Opening a page`;
  }
}

/**
 * How a turn ended, or null for an ordinary end, which needs no words: the
 * reply is the answer. A refusal is said plainly (§5.3) rather than left as
 * an empty reply.
 */
export function endLabel(reason: TurnEndReason): string | null {
  switch (reason) {
    case 'done':
      return null;
    case 'max_steps':
      return $localize`:@@assistant.end.maxSteps:The assistant stopped: this question needed more steps than it may take.`;
    case 'budget':
      return $localize`:@@assistant.end.budget:This conversation is too long to go on. Start over to ask something else.`;
    case 'cancelled':
      return $localize`:@@assistant.end.cancelled:Stopped.`;
    case 'refused':
      return $localize`:@@assistant.end.refused:The assistant declined to answer that.`;
    case 'error':
      return $localize`:@@assistant.end.error:The assistant ran into a problem and stopped.`;
  }
}

/** Why the last action failed. The host's detail, when it gave one, is shown after this as sent. */
export function problemLabel(problem: ConversationProblem): string {
  switch (problem.code) {
    case 'turn-running':
      return $localize`:@@assistant.problem.turnRunning:The assistant is still answering. Wait for it, or stop it.`;
    case 'failed':
      return $localize`:@@assistant.problem.failed:Your message was not sent.`;
    case 'provider':
      return $localize`:@@assistant.problem.provider:The assistant's provider failed.`;
    case 'gone':
      return $localize`:@@assistant.problem.gone:This conversation has ended. Your next message starts a new one.`;
  }
}
