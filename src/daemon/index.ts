export {
  buildLogs,
  buildState,
  buildSnapshot,
  locatePidCommand,
  shellQuote,
  CommandError,
  type LogsFlags,
} from "./commands";
export { SessionPool, type FactoryMaker } from "./pool";
export { dispatch, type DispatchDeps } from "./dispatch";
export { fileAuditSink, type AuditEntry, type AuditSink } from "./audit";
export { Daemon } from "./server";
export {
  planUpload,
  readArtifact,
  parseChecksum,
  type Artifact,
  type UploadPlan,
  type PlanUploadOpts,
} from "./upload";
export {
  EventBus,
  connectionChain,
  type WatchEvent,
  type WatchSubscriber,
  type EventBusOptions,
} from "./watch";
export {
  defaultSocketPath,
  defaultAuditPath,
  defaultRegistryDbPath,
  defaultTokenPath,
} from "./paths";
export type {
  RpcRequest,
  RpcResponse,
  RpcMethod,
  RpcOk,
  RpcErr,
  RunResultPayload,
} from "./protocol";
