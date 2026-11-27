import { createContext } from 'react'
import type { MailView } from '../shared/mail'

export const OpenMailPage = createContext<(view: MailView, trigger: HTMLButtonElement) => void>(
  () => {},
)
