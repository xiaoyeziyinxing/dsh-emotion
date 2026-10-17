declare const window: {
    __ModuleLoader__: {
        load(spec: unknown): void;
    };
};
declare const document: {
    baseURI?: string;
    visibilityState: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
};
