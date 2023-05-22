import type { Callback, Observable, UnsubscribeCallback } from "./EventSource";
import { makeEventSource } from "./EventSource";

const DEDUPLICATION_INTERVAL = 2000;

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

type AsyncFunction<T, A extends any[] = any[]> = (...args: A) => Promise<T>;

type AsyncCacheOptions = {
  deduplicationInterval?: number;
};

type AsyncCacheItemOptions = WithRequired<
  AsyncCacheOptions,
  "deduplicationInterval"
>;

type InvalidateOptions = {
  keepPreviousData?: boolean;
};

export type AsyncState<TData = any, TError = any> = {
  isLoading: boolean;
  data?: TData;
  error?: TError;
};

type AsyncResolvedState<TData = any, TError = any> = AsyncState<
  TData,
  TError
> & {
  isLoading: false;
};

type AsyncCacheItemContext<TData, TError> = AsyncState<TData, TError> & {
  isInvalid: boolean;
  hasScheduledInvalidation: boolean;
  promise?: Promise<TData>;
  lastExecutedAt?: number;
};

export type AsyncCacheItem<TData = any, TError = any> = Observable<
  AsyncState<TData, TError>
> & {
  get(): Promise<AsyncResolvedState<TData, TError>>;
  getState(): AsyncState<TData, TError>;
  invalidate(options?: InvalidateOptions): void;
};

export type AsyncCache<TData = any, TError = any> = {
  create(key: string): AsyncCacheItem<TData, TError>;
  get(key: string): Promise<AsyncResolvedState<TData, TError>>;
  getState(key: string): AsyncState<TData, TError> | undefined;
  invalidate(key: string, options?: InvalidateOptions): void;
  subscribe(
    key: string,
    callback: Callback<AsyncState<TData, TError>>
  ): UnsubscribeCallback;
  has(key: string): boolean;
  clear(): void;
};

const noop = () => {};

function getKeys<T extends object>(value: T) {
  if (value instanceof Error) {
    return ["name", "message"];
  } else {
    return Object.keys(value);
  }
}

function deepCompare(a: any, b: any): boolean {
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return a === b;
  }

  const keysA = getKeys(a);
  const keysB = getKeys(b);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (
      !(key in b) ||
      !deepCompare(
        (a as Record<string, any>)[key],
        (b as Record<string, any>)[key]
      )
    ) {
      return false;
    }
  }

  return true;
}

export function isStateEqual(a: AsyncState, b: AsyncState): boolean {
  if (
    a.isLoading !== b.isLoading ||
    ((a.data === undefined) !== b.data) === undefined ||
    ((a.error === undefined) !== b.error) === undefined
  ) {
    return false;
  } else {
    return deepCompare(a, b);
  }
}

function createCacheItem<TData = any, TError = any>(
  key: string,
  asyncFunction: AsyncFunction<TData>,
  { deduplicationInterval }: AsyncCacheItemOptions
): AsyncCacheItem<TData, TError> {
  const context: AsyncCacheItemContext<TData, TError> = {
    isLoading: false,
    isInvalid: true,
    hasScheduledInvalidation: false,
  };
  const eventSource = makeEventSource<AsyncState<TData, TError>>();
  let previousState = getState();

  function notify() {
    const newState = getState();

    if (!isStateEqual(previousState, newState)) {
      previousState = newState;
      eventSource.notify(newState);
    }
  }

  function execute() {
    context.lastExecutedAt = Date.now();
    context.error = undefined;
    context.isLoading = true;
    context.isInvalid = true;
    context.promise = asyncFunction(key);

    notify();
  }

  async function resolve() {
    try {
      const data = await context.promise;

      context.data = data;
      context.error = undefined;
      context.isInvalid = false;
    } catch (error) {
      context.error = error as TError;
      context.isInvalid = true;
    }

    context.promise = undefined;
    context.isLoading = false;

    if (context.hasScheduledInvalidation) {
      context.hasScheduledInvalidation = false;
      invalidate();
    } else {
      notify();
    }
  }

  function invalidate(options?: InvalidateOptions) {
    if (context.promise) {
      context.hasScheduledInvalidation = true;
    } else if (!context.hasScheduledInvalidation) {
      const keepPreviousData = options?.keepPreviousData ?? false;
      context.isInvalid = true;
      context.error = undefined;

      if (!keepPreviousData) {
        context.data = undefined;
      }

      notify();
    }
  }

  async function get() {
    if (context.isInvalid) {
      const isDuplicate = context.lastExecutedAt
        ? Date.now() - context.lastExecutedAt < deduplicationInterval
        : false;

      if (!context.promise && !isDuplicate) {
        execute();
      }

      if (context.promise) {
        await resolve();
      }
    }

    return getState() as AsyncResolvedState<TData, TError>;
  }

  function getState() {
    return {
      isLoading: context.isLoading,
      data: context.data,
      error: context.error,
    } as AsyncState<TData, TError>;
  }

  return {
    ...eventSource.observable,
    get,
    getState,
    invalidate,
  };
}

export function createAsyncCache<TData = any, TError = any>(
  asyncFunction: AsyncFunction<TData, [string]>,
  options?: AsyncCacheOptions
): AsyncCache<TData, TError> {
  const cache = new Map<string, AsyncCacheItem<TData, TError>>();
  const cacheItemOptions: AsyncCacheItemOptions = {
    deduplicationInterval:
      options?.deduplicationInterval ?? DEDUPLICATION_INTERVAL,
  };

  function create(key: string) {
    let cacheItem = cache.get(key);

    if (cacheItem) {
      return cacheItem;
    }

    cacheItem = createCacheItem(key, asyncFunction, cacheItemOptions);
    cache.set(key, cacheItem);

    return cacheItem;
  }

  async function get(key: string) {
    return create(key).get();
  }

  function getState(key: string) {
    return cache.get(key)?.getState();
  }

  function invalidate(key: string, options?: InvalidateOptions) {
    cache.get(key)?.invalidate(options);
  }

  function subscribe(
    key: string,
    callback: Callback<AsyncState<TData, TError>>
  ) {
    return create(key).subscribe(callback) ?? noop;
  }

  function has(key: string) {
    return cache.has(key);
  }

  function clear() {
    cache.clear();
  }

  return {
    create,
    get,
    getState,
    invalidate,
    subscribe,
    has,
    clear,
  };
}