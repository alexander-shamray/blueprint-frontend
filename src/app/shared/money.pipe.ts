import { LOCALE_ID, Pipe, PipeTransform, inject } from '@angular/core';

/**
 * The one place an amount becomes text: `{{ line.lineTotal | money: q.currency }}`.
 *
 * It formats and never computes (`client-architecture.md` §9): the amount is
 * the server's number and the currency the server's code, and both go to
 * `Intl.NumberFormat` as they arrived. `maximumFractionDigits` is lifted to
 * the format's ceiling so the formatter pads and never rounds — a currency's
 * own minor unit is a default, and applying it to a price at `PriceAmount`'s
 * full scale (`client-architecture.md` §12, "A product may cost nothing")
 * would be the client rounding an amount the platform did not round. Padding
 * `12.5` to `12.50` changes how the number is written, not which number it is.
 *
 * The backend constrains a currency only as three letters, so a code `Intl`
 * has no symbol for is still legal there and is written as the code itself,
 * which is `Intl`'s own behaviour. A code that is not three letters at all
 * throws a `RangeError` in the constructor; that is a contract violation
 * upstream rather than something to hide, so it is rendered as sent —
 * `12.5 XX` — instead of failing the whole template over one row.
 */
@Pipe({ name: 'money', standalone: true })
export class MoneyPipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);

  transform(amount: number, currency: string): string {
    try {
      return new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: 20,
      }).format(amount);
    } catch {
      return `${amount} ${currency}`;
    }
  }
}
