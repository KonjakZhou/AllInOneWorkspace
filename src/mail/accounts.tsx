import { useEffect, useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import { ChoicePicker } from '../components/ChoicePicker'
import { Modal } from '../components/Modal'
import { errorMessage } from '../shared/model'
import {
  mailProviderNames,
  mailSetupGuides,
  type MailAPI,
  type MailAccount,
  type MailConnect,
  type MailProvider,
  type MailState,
} from '../shared/mail'

const providerOptions = (Object.keys(mailProviderNames) as MailProvider[]).map((value) => ({
  value,
  label: mailProviderNames[value],
}))
const feishuMethods = [
  { value: 'imap', label: 'IMAP 专用密码' },
  { value: 'quick', label: '飞书快捷授权' },
  { value: 'custom', label: '自建飞书应用' },
] as const
type FeishuMethod = (typeof feishuMethods)[number]['value']

export function useMailAccounts(api: MailAPI) {
  const [state, setState] = useState<MailState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let revision = 0
    const refresh = () => {
      const request = ++revision
      void api.state().then(
        (value) => {
          if (active && revision === request) {
            setState(value)
            setError('')
          }
        },
        (reason) => {
          if (active && revision === request) setError(errorMessage(reason))
        },
      )
    }
    const off = api.onChanged((change) => {
      if (change.kind === 'accounts' || change.kind === 'status') refresh()
    })
    refresh()
    return () => {
      active = false
      off()
    }
  }, [api])
  return { state, error }
}

export function MailAccounts({
  api,
  state,
  close,
}: {
  api: MailAPI
  state: MailState | null
  close: () => void
}) {
  const [provider, setProvider] = useState<MailProvider>('feishu')
  const [target, setTarget] = useState<MailAccount | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [feishuMethod, setFeishuMethod] = useState<FeishuMethod>('imap')
  const [appId, setAppId] = useState('')
  const [appSecret, setSecret] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [path, setPath] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [disconnect, setDisconnect] = useState<MailAccount | null>(null)
  const active = working || !!state?.setup
  const usesImap = provider === 'netease' || (provider === 'feishu' && feishuMethod === 'imap')
  const needsSentFolder = usesImap && folders.length > 0 && !path
  const guide = provider === 'feishu' ? (usesImap ? 'feishuImap' : 'feishuOAuth') : provider
  const guideLabel = {
    feishuImap: '查看飞书专用密码获取教程',
    feishuOAuth: '查看飞书应用权限申请教程',
    netease: '查看 163 客户端授权码获取教程',
    gmail: '查看 Gmail 桌面 OAuth 配置教程',
  }[guide]

  function clearImapSetup() {
    setPassword('')
    setFolders([])
    setPath('')
  }

  function select(next: MailProvider, account: MailAccount | null = null) {
    setProvider(next)
    setTarget(account)
    setEmail(account?.email ?? '')
    clearImapSetup()
    setFeishuMethod(account?.feishuMethod === 'oauth' ? 'quick' : 'imap')
    setAppId('')
    setSecret('')
    setError('')
  }

  async function perform(action: () => Promise<unknown>) {
    setWorking(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setWorking(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (active || needsSentFolder) return
    const reconnect = target?.id
    const imap = { email, password, sentPath: path || undefined, reconnect }
    let input: MailConnect
    if (provider === 'gmail') input = { provider, reconnect }
    else if (provider === 'netease') input = { provider, ...imap }
    else if (feishuMethod === 'imap') input = { provider, method: 'imap', ...imap }
    else if (feishuMethod === 'custom') input = { provider, appId, appSecret, reconnect }
    else input = { provider, reconnect }
    void perform(async () => {
      const result = await api.connect(input)
      if ('sentFolders' in result) {
        setFolders(result.sentFolders)
        setPath('')
        return
      }
      select(provider)
    })
  }

  return (
    <Modal title="邮箱账号" wide locked={active} onClose={close}>
      {!!state?.accounts.length && (
        <ul className="account-list mail-accounts" aria-label="已连接邮箱">
          {state.accounts.map((account) => (
            <li
              className={['account-row', (disconnect ?? target)?.id === account.id && 'selected']
                .filter(Boolean)
                .join(' ')}
              key={account.id}
            >
              <span className="account-details">
                <strong title={account.email}>{account.email}</strong>
                <small>
                  {mailProviderNames[account.provider]}
                  {account.issue ? ' · ' + account.issue : ''}
                </small>
              </span>
              <button
                className="button small"
                disabled={active}
                onClick={() => select(account.provider, account)}
              >
                重新授权
              </button>
              <button
                className="button small"
                disabled={active}
                onClick={() => {
                  setDisconnect(account)
                  setError('')
                }}
              >
                断开
              </button>
            </li>
          ))}
        </ul>
      )}
      {disconnect ? (
        <div className="form-stack">
          <p className="notice notice-error mail-account-notice">
            断开 {disconnect.email} 并清除它在本工作区的邮箱缓存？
          </p>
          <div className="button-row align-end">
            <button className="button" disabled={active} onClick={() => setDisconnect(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={active}
              onClick={() =>
                void perform(async () => {
                  await api.disconnect(disconnect.id)
                  if (target?.id === disconnect.id) select(provider)
                  setDisconnect(null)
                })
              }
            >
              断开连接
            </button>
          </div>
        </div>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          {(!!target || !!state?.accounts.length) && (
            <h3 className="mail-account-title">
              {target ? '重新授权 ' + target.email : '添加邮箱'}
            </h3>
          )}
          <ChoicePicker
            label="服务商"
            showLabel
            value={provider}
            options={providerOptions}
            disabled={active}
            onChange={select}
          />
          {provider === 'feishu' && (
            <>
              <ChoicePicker
                label="连接方式"
                showLabel
                value={feishuMethod}
                options={feishuMethods}
                disabled={active}
                onChange={(next) => {
                  setFeishuMethod(next)
                  clearImapSetup()
                  setSecret('')
                  setError('')
                }}
              />
              {feishuMethod === 'custom' && (
                <>
                  <label>
                    App ID
                    <input
                      required
                      value={appId}
                      disabled={active}
                      onChange={(event) => setAppId(event.target.value)}
                    />
                  </label>
                  <label>
                    App Secret
                    <input
                      required
                      type="password"
                      value={appSecret}
                      disabled={active}
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </label>
                  <p className="field-hint">
                    请为应用配置邮件读取、修改和离线访问权限，并添加回调地址{' '}
                    <code>http://127.0.0.1:43821/oauth/feishu/callback</code>。
                  </p>
                </>
              )}
            </>
          )}
          {provider === 'gmail' && (
            <>
              <p className="field-hint">
                在 Google Cloud 启用 Gmail API、配置 OAuth
                同意屏幕，再创建「桌面应用」客户端并导入下载的 JSON。外部应用处于 Testing
                时，刷新令牌通常在 7 天后过期。
              </p>
              <div>
                <button
                  className="button small"
                  type="button"
                  disabled={active}
                  onClick={() => void perform(() => api.importGoogle())}
                >
                  {state?.gmailConfigured ? '更换 Google OAuth 配置' : '导入 Google OAuth 配置'}
                </button>
              </div>
            </>
          )}
          {usesImap && (
            <>
              <label>
                {mailProviderNames[provider]}地址
                <input
                  type="email"
                  required
                  value={email}
                  disabled={active || !!target}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    clearImapSetup()
                  }}
                />
              </label>
              <label>
                {provider === 'feishu' ? '客户端专用密码' : '客户端授权码'}
                <input
                  type="password"
                  autoComplete="off"
                  required
                  value={password}
                  disabled={active}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setFolders([])
                    setPath('')
                  }}
                />
              </label>
              <p className="field-hint">
                {provider === 'feishu'
                  ? '管理员允许第三方客户端登录后，在飞书桌面端的邮箱设置中生成专用密码。'
                  : '在网页版 163 邮箱设置中开启 IMAP，并生成客户端授权码。'}
              </p>
              {!!folders.length && (
                <ChoicePicker
                  label="已发送文件夹"
                  showLabel
                  value={path}
                  options={folders.map((name) => ({ value: name, label: name }))}
                  disabled={active}
                  onChange={setPath}
                />
              )}
            </>
          )}
          <div>
            <a
              className="mail-setup-guide"
              href={mailSetupGuides[guide]}
              onClick={(event) => {
                event.preventDefault()
                void api.openSetupGuide(guide).catch((reason) => setError(errorMessage(reason)))
              }}
            >
              {guideLabel}
            </a>
          </div>
          {state?.setup && (
            <div className="notice mail-account-notice mail-setup" role="status">
              {state.setup.code ? (
                <p>
                  授权验证码 <strong>{state.setup.code}</strong>
                </p>
              ) : (
                <p>请完成邮箱连接。</p>
              )}
              <div className="button-row">
                {state.setup.url && (
                  <button
                    className="button small"
                    type="button"
                    onClick={() =>
                      void api.reopen().catch((reason) => setError(errorMessage(reason)))
                    }
                  >
                    重新打开授权页
                  </button>
                )}
                <button
                  className="button small"
                  type="button"
                  onClick={() =>
                    void api.cancel().catch((reason) => setError(errorMessage(reason)))
                  }
                >
                  取消授权
                </button>
              </div>
            </div>
          )}
          <div className="button-row align-end">
            {target && (
              <button
                className="button"
                type="button"
                disabled={active}
                onClick={() => select(provider)}
              >
                返回添加
              </button>
            )}
            <button
              className="button primary"
              disabled={
                active ||
                needsSentFolder ||
                (provider === 'gmail' && !state?.gmailConfigured && !target)
              }
            >
              <Plus size={15} />
              {active ? '正在连接…' : target ? '重新连接' : '连接邮箱'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
