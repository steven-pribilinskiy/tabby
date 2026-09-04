import { NgModule } from '@angular/core'
import { TerminalDecorator } from 'tabby-terminal'

import { RenderTimingDecorator } from './decorator'

export { RenderTiming } from './timing'

/** @hidden */
@NgModule({
    providers: [
        { provide: TerminalDecorator, useClass: RenderTimingDecorator, multi: true },
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class RenderTimingModule { }
