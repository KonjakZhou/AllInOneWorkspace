import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ExternalLink, Mail, Plus, Reply } from 'lucide-react'
import { Modal } from '../components/Modal'
import { WidgetEmpty, WidgetLoading } from '../sdk/components'
import { errorMessage } from '../shared/model'
import {
  mailKey,
  mailProviderNames,
  type MailAPI,
  type MailAccount,
  type MailDetail,
  type MailRef,
  type MailView,
} from '../shared/mail'
import { MailAccounts, useMailAccounts } from './accounts'
import { displayAddress, filterKey, MailFeed, MailFilters } from './feed'
import './mail.css'

function Detail({
  api,
  reference,
  account,
}: {
  api: MailAPI
  reference: MailRef
  account: MailAccount
}) {
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [readError, setReadError] = useState('')
  const [notice, setNotice] = useState('')
  const [replying, setReplying] = useState(false)
  const { account: accountId, id } = reference
  useEffect(() => {
    let active = true
    let markedRead = false
    const off = api.onChanged((change) => {
      if (
        change.kind !== 'read' ||
        change.message.account !== accountId ||
        change.message.id !== id
      )
        return
      markedRead = true
      setDetail(
        (current) => current && { ...current, message: { ...current.message, unread: false } },
      )
    })
    void api.detail({ account: accountId, id }).then(
      (value) => {
        if (active)
          setDetail(markedRead ? { ...value, message: { ...value.message, unread: false } } : value)
      },
      (reason) => {
        if (active) setError(errorMessage(reason))
      },
    )
    return () => {
      active = false
      off()
    }
  }, [api, accountId, id])

  const markAsRead = useCallback(async () => {
    setWorking(true)
    try {
      await api.markRead({ account: accountId, id })
      setDetail(
        (current) => current && { ...current, message: { ...current.message, unread: false } },
      )
      setReadError('')
    } catch (reason) {
      setReadError(errorMessage(reason))
    } finally {
      setWorking(false)
    }
  }, [api, accountId, id])

  const unread = detail?.message.unread
  useEffect(() => {
    if (unread) void markAsRead()
  }, [unread, markAsRead])

  function act(action: () => Promise<void>) {
    setError('')
    void action().catch((reason) => setError(errorMessage(reason)))
  }

  if (!detail)
    return (
      <section className="mail-detail">
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : (
          <WidgetLoading message="正在读取正文…" />
        )}
      </section>
    )
  const { message, body } = detail
  const from = message.from.map(displayAddress).join('，')
  const to = message.to.map(displayAddress).join('，')
  const replyHint = detail.gmail?.threadId
    ? '打开 Gmail 原邮件会话以回复'
    : detail.gmail?.messageId
      ? '在 Gmail 中定位原邮件以回复'
      : message.subject.trim() || message.from[0]?.email.trim()
        ? '打开邮箱并复制搜索关键词，找到原邮件后回复'
        : '打开邮箱，找到原邮件后回复'

  return (
    <section className="mail-detail" aria-label="邮件详情">
      <header className="mail-detail-header">
        <h2>{message.subject || '（无主题）'}</h2>
        <dl>
          <div>
            <dt>发件人</dt>
            <dd>{from || '未知'}</dd>
          </div>
          <div>
            <dt>收件人</dt>
            <dd>{to || '未知'}</dd>
          </div>
          <div>
            <dt>时间</dt>
            <dd>{new Date(message.time).toLocaleString('zh-CN')}</dd>
          </div>
          <div>
            <dt>邮箱</dt>
            <dd>{account.email}</dd>
          </div>
        </dl>
        <div className="button-row">
          {message.unread && readError && (
            <button className="button small" disabled={working} onClick={() => void markAsRead()}>
              <Check size={14} /> 重试标为已读
            </button>
          )}
          <button
            className="button small"
            title={'在浏览器中打开 ' + account.email + '，可继续查找原邮件或回复'}
            onClick={() => act(() => api.openMailbox(account.id))}
          >
            <ExternalLink size={14} /> 打开邮箱
          </button>
          <button
            className="button small"
            disabled={replying}
            onClick={() =>
              act(async () => {
                setReplying(true)
                setNotice('')
                try {
                  const result = await api.openReply(message)
                  setNotice(
                    {
                      thread: '已打开 Gmail 会话，请在邮箱中回复。',
                      search: '已打开 Gmail 搜索结果，请打开原邮件后回复。',
                      mailbox: '已打开邮箱，请找到原邮件后回复。',
                      'mailbox-with-keyword': '已打开邮箱并复制搜索关键词，请粘贴搜索后回复。',
                    }[result],
                  )
                } finally {
                  setReplying(false)
                }
              })
            }
          >
            <Reply size={14} aria-hidden="true" /> 在邮箱中回复
            <span className="control-hint" aria-hidden="true">
              {replyHint}
            </span>
          </button>
        </div>
        {notice && (
          <p className="mail-detail-feedback" role="status">
            {notice}
          </p>
        )}
        {message.unread && readError && (
          <p className="inline-error" role="alert">
            未能标为已读。{readError}
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </header>
      <div className="mail-body">{body || '（此邮件没有可显示的纯文本正文）'}</div>
    </section>
  )
}

export default function MailPage({
  initialView,
  active,
  onBack,
}: {
  initialView: MailView
  active: boolean
  onBack: () => void
}) {
  const { accountId } = initialView
  const api = useMemo(() => window.workspace.mailFor(accountId), [accountId])
  const { state, error: accountError } = useMailAccounts(api)
  const [navigation, setNavigation] = useState({ entry: initialView, view: initialView })
  const view = navigation.entry === initialView ? navigation.view : initialView
  const setView = (next: MailView) => setNavigation({ entry: initialView, view: next })
  const back = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (active) back.current?.focus({ preventScroll: true })
  }, [active, initialView])
  const [managing, setManaging] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const accounts = state?.accounts ?? []
  const account = accounts.find(({ id }) => view.selected?.account === id)
  const filter = {
    ...view.filter,
    account: accounts.some(({ id }) => id === view.filter.account) ? view.filter.account : null,
  }

  function openAccount(id: string) {
    setChoosing(false)
    setError('')
    void api.openMailbox(id).catch((reason) => setError(errorMessage(reason)))
  }

  function compose() {
    if (filter.account) openAccount(filter.account)
    else if (accounts.length === 1) openAccount(accounts[0].id)
    else setChoosing(true)
  }

  return (
    <main className="mail-page">
      <header className="workspace-detail-header">
        <div className="workspace-detail-title">
          <Mail size={22} aria-hidden="true" />
          <h1>邮箱</h1>
          <button
            type="button"
            className="button small workspace-detail-back"
            ref={back}
            onClick={onBack}
          >
            <ArrowLeft size={16} aria-hidden="true" /> 返回工作区
          </button>
        </div>
        <div className="toolbar-actions">
          <button
            className="button"
            disabled={!accounts.length}
            title="在邮箱中撰写邮件"
            onClick={compose}
          >
            <ExternalLink size={15} /> 打开邮箱
          </button>
          <button
            className="button primary"
            aria-haspopup="dialog"
            onClick={() => setManaging(true)}
          >
            <Plus size={15} /> 添加邮箱账户
          </button>
        </div>
      </header>
      {(error || accountError) && (
        <p className="notice notice-error mail-page-notice" role="alert">
          {error || accountError}
        </p>
      )}
      <div className="panel mail-page-content">
        <section className="mail-page-list">
          <div className="mail-controls">
            <MailFilters
              filter={filter}
              accounts={accounts}
              change={(filter) => setView({ accountId, filter, selected: null })}
            />
          </div>
          <MailFeed
            key={filterKey(filter) + ':' + accounts.map(({ id }) => id).join(',')}
            api={api}
            filter={filter}
            active={active}
            selected={view.selected}
            startAt={view.startAt}
            accounts={accounts}
            select={(message) =>
              setView({
                ...view,
                selected: { account: message.account, id: message.id },
              })
            }
          />
        </section>
        {active && account && view.selected ? (
          <Detail
            key={mailKey(view.selected)}
            api={api}
            reference={view.selected}
            account={account}
          />
        ) : (
          <section className="mail-detail">
            <WidgetEmpty icon={<Mail size={26} />} message="选择一封邮件查看详情" />
          </section>
        )}
      </div>
      {managing && <MailAccounts api={api} state={state} close={() => setManaging(false)} />}
      {choosing && (
        <Modal title="选择要打开的邮箱" onClose={() => setChoosing(false)}>
          <div className="account-list">
            {accounts.map(({ id, email, provider }) => (
              <div className="account-row" key={id}>
                <button className="account-select" onClick={() => openAccount(id)}>
                  <span className="avatar">
                    <Mail size={15} />
                  </span>
                  <span className="account-details">
                    <strong title={email}>{email}</strong>
                    <small>{mailProviderNames[provider]}</small>
                  </span>
                  <ExternalLink size={14} />
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </main>
  )
}
