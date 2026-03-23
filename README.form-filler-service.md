# FormFillerService

## What It Is

`FormFillerService` is a generic XPath-based form automation utility.
It fills fields by config so you do not write per-site hardcoded form logic each time.

## How It Works

Main method:

- `fillForm(page, fields, options?)`

Field config:

- `xpath`: target field XPath
- `type`: `text | textarea | select | checkbox | radio | click | file`
- `value`: value to fill/check/upload
- `optional`: skip errors for non-critical fields
- `timeoutMs`: wait timeout for element
- `clearBeforeType`: for text/textarea behavior

Form options:

- `stopOnError`: stop immediately or continue
- `delayMsBetweenFields`: throttle actions

## Example: Use In Another Service

```ts
import { Injectable } from '@nestjs/common';
import { FormFillerService } from './form-filler.service';
import { Page } from 'playwright';

@Injectable()
export class ProfileSubmitService {
  constructor(private readonly formFillerService: FormFillerService) {}

  async fillProfileForm(page: Page): Promise<void> {
    await this.formFillerService.fillForm(
      page,
      [
        { xpath: "//input[@name='name']", type: 'text', value: 'John Doe' },
        { xpath: "//input[@name='email']", type: 'text', value: 'john@demo.com' },
        { xpath: "//select[@name='country']", type: 'select', value: 'IN' },
        { xpath: "//input[@name='terms']", type: 'checkbox', value: true },
        { xpath: "//button[@type='submit']", type: 'click' },
      ],
      { stopOnError: true, delayMsBetweenFields: 150 },
    );
  }
}
```
