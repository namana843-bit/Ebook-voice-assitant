
export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export interface SessionState {
  isActive: boolean;
  isConnecting: boolean;
  error: string | null;
}
