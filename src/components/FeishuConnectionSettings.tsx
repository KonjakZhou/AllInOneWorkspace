import { useEffect, useRef, useState } from 'react'
import { FEISHU_REDIRECT_URI, FEISHU_SCOPES, type FeishuConnection } from '../shared/feishu'
import { errorMessage } from '../shared/model'

export const connectionLabels: Record<FeishuConnection['status'], string> = {
  unconfigured: '未配置',
  not_connected: '未连接',
  connecting: '等待授权',
  connected: '已连接',
  reauth_required: '授权已失效',
  permission_denied: '权限不足',
}

export function FeishuConnectionSettings({
  accountId,
  accountName,
}: {
  accountId: string
  accountName: string
}) {
  const [connection, setConnection] = useState<FeishuConnection | null>(null)
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [configuring, setConfiguring] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const mounted = useRef(false)
  const api = window.workspace.feishu
  useEffect(() => {
    mounted.current = true
    let sequence = 0
    const read = async () => {
      const current = ++sequence
      try {
        const result = await api.getConnection(accountId)
        if (!mounted.current || current !== sequence) return
        setConnection(result)
        setAppId((previous) => previous || result.appId || '')
      } catch (err) {
        if (mounted.current && current === sequence) setError(errorMessage(err))
      }
    }
    void read()
    const off = api.onChanged(accountId, () => void read())
    return () => {
      mounted.current = false
      sequence++
      off()
    }
  }, [accountId, api])
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      if (mounted.current) setError(errorMessage(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const connecting = connection?.status === 'connecting'
  return (
    <section className="settings-section feishu-settings" aria-label="飞书连接设置">
      <span className="eyebrow">CURRENT ACCOUNT · FEISHU</span>
      <h3>{accountName} → 飞书连接</h3>
      <div className="feishu-identity">
        <span className="badge">
          {connection ? connectionLabels[connection.status] : error ? '读取失败' : '读取中…'}
        </span>
        {connection?.identity && <strong>{connection.identity.name || '飞书用户'}</strong>}
      </div>
      <p>
        此账号下的所有日历组件共用连接。仅读取个人主日历；凭证只保存在本机，导入账号后需要重新授权。
      </p>
      {(configuring || (connection && !connection.configured)) && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault()
            void perform(async () => {
              const result = await api.saveConfig(accountId, { appId, appSecret: secret })
              if (mounted.current) {
                setConnection(result)
                setSecret('')
                setConfiguring(false)
              }
            })
          }}
        >
          <label>
            App ID
            <input
              aria-label="飞书 App ID"
              value={appId}
              autoComplete="off"
              required
              pattern="cli_[a-zA-Z0-9]+"
              onChange={(event) => setAppId(event.target.value)}
              disabled={busy || connecting}
            />
          </label>
          <label>
            App Secret
            <input
              aria-label="飞书 App Secret"
              type="password"
              value={secret}
              autoComplete="new-password"
              required
              maxLength={512}
              onChange={(event) => setSecret(event.target.value)}
              disabled={busy || connecting}
              placeholder="保存后不再显示密钥"
            />
          </label>
          <div className="button-row">
            <button className="button" disabled={busy || connecting}>
              保存应用配置
            </button>
            {configuring && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  setConfiguring(false)
                  setSecret('')
                }}
              >
                取消修改
              </button>
            )}
          </div>
        </form>
      )}
      <div className="button-row">
        {connection?.configured && (
          <>
            <button
              className="button primary"
              disabled={busy || connecting || configuring}
              onClick={() => void perform(() => api.authorize(accountId))}
            >
              {connection.identity ? '重新授权' : '授权连接飞书'}
            </button>
            <button
              className="button"
              disabled={busy || connecting}
              onClick={() => {
                setAppId(connection.appId ?? '')
                setConfiguring(!configuring)
                setSecret('')
              }}
            >
              修改应用配置
            </button>
          </>
        )}
        {connecting && (
          <button
            className="button"
            disabled={busy}
            onClick={() => void perform(() => api.cancelAuthorization(accountId))}
          >
            取消授权
          </button>
        )}
        {(connection?.configured || error) && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => setConfirmDisconnect(true)}
          >
            断开连接
          </button>
        )}
      </div>
      {connecting && (
        <p role="status">
          请在系统浏览器中完成授权。有效期五分钟；切换工作区不会改变此次授权的目标账号。
        </p>
      )}
      {connection?.message && <p role="status">{connection.message}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {confirmDisconnect && (
        <div className="feishu-confirm">
          <p>断开后将清除“{accountName}”的飞书应用配置、凭证和日程缓存，需要重新配置授权。</p>
          <div className="button-row">
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api.disconnect(accountId)
                  if (mounted.current) {
                    setConfirmDisconnect(false)
                    setSecret('')
                    setAppId('')
                    setConfiguring(false)
                  }
                })
              }
            >
              确认断开飞书
            </button>
            <button className="button" disabled={busy} onClick={() => setConfirmDisconnect(false)}>
              保留连接
            </button>
          </div>
        </div>
      )}
      <details className="feishu-guide">
        <summary>如何配置飞书自建应用</summary>
        <ol>
          <li>在飞书开放平台创建企业自建应用，复制 App ID 和 App Secret。</li>
          <li>
            在权限管理中开启用户身份权限：<code>{FEISHU_SCOPES.join('、')}</code>。
          </li>
          <li>
            在安全设置中添加完全一致的重定向地址：
            <code className="path-display">{FEISHU_REDIRECT_URI}</code>
          </li>
          <li>
            创建版本并发布，确认你的飞书身份在应用可用范围内。保存配置后点击授权，在浏览器确认授权。
          </li>
        </ol>
        <p>详细说明见仓库 docs/feishu-calendar.md。密钥使用系统钥匙串加密；更换设备后重新配置。</p>
      </details>
    </section>
  )
}
