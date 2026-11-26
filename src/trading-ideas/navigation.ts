import { createContext } from 'react'
import type { IdeaView } from '../shared/trading-ideas'

export const OpenIdeasPage = createContext<(view: IdeaView, trigger: HTMLButtonElement) => void>(
  () => {},
)
