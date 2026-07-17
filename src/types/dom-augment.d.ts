// Pragmatic DOM augmentations for the mechanical JS→TS port.
//
// The chrome-UI scripts frequently reach form/input members through generic
// element references (document.getElementById → HTMLElement | null,
// event.target → EventTarget). Rather than casting hundreds of call sites,
// the members the UI actually uses are declared optional on the base
// interfaces. This trades a little type safety for zero code churn — when
// touching a call site, prefer narrowing to the concrete element type
// (HTMLInputElement etc.) over relying on these.

interface HTMLElement {
    value?: any;
    checked?: boolean;
    disabled?: boolean;
    placeholder?: string;
    select?: () => void;
    selectionStart?: number | null;
    selectionEnd?: number | null;
    setSelectionRange?: (start: number, end: number) => void;
    options?: any;
    min?: string;
    src?: string;
    content?: any;
    width?: number;
    height?: number;
    getContext?: (kind: string, opts?: any) => any;
}

interface Element {
    dataset?: DOMStringMap;
    style?: CSSStyleDeclaration;
    value?: any;
    checked?: boolean;
}

interface EventTarget {
    closest?: (selector: string) => Element | null;
    value?: any;
    checked?: boolean;
    disabled?: boolean;
    textContent?: string | null;
    getBoundingClientRect?: () => DOMRect;
}

// Loaded globally on pages that include the DOMPurify script tag.
declare const DOMPurify: any;

interface Node {
    // Overload: the UI passes e.target / e.relatedTarget (EventTarget) straight in.
    contains(other: EventTarget | Node | null): boolean;
}

interface Event {
    dataTransfer?: DataTransfer | null;   // generic Element listeners get Event, not DragEvent
    relatedTarget?: EventTarget | null;
}

// Globals the chrome UI itself hangs on window (not preload bridges).
interface Window {
    pinActiveTab?: () => void;
    // Given a cursor x, returns the tab index to insert after (-1 = front, null = append).
    __tabDropIndex?: ((x: number) => number | null) | null;
}
