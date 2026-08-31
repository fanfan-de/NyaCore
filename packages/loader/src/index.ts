/** 本文件是 `@nya/loader` 的公开入口，只导出稳定的 Loader API 与类型。 */

export {
  Loader,
  LoaderGroup,
} from './loader.js'
export { defaultLoaderResolver } from './resolver.js'
export type {
  Awaitable,
  ComponentEntryInput,
  EntryInput,
  EntrySnapshot,
  EntryState,
  EntryType,
  EntryUpdate,
  GroupEntryInput,
  LoaderConfig,
  LoaderResolution,
  LoaderResolveRequest,
  LoaderResolver,
} from './types.js'
