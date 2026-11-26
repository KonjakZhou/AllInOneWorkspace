export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'
  | 'unavailable'
export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  version?: string
  automatic: boolean
  checkedAt?: number
  progress?: number
  message?: string
  releaseUrl?: string
  canInstall: boolean
}
export interface UpdatesAPI {
  getState(): Promise<UpdateState>
  onChanged(callback: (state: UpdateState) => void): () => void
  check(): Promise<void>
  download(): Promise<void>
  setAutomatic(enabled: boolean): Promise<void>
  install(): Promise<void>
  openRelease(): Promise<void>
}
