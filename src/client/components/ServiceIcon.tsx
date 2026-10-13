import { MarkGithubIcon } from '@primer/octicons-react';
import type { ForgeKind } from '../../shared/types';

const serviceNames: Record<ForgeKind, string> = { github: 'GitHub', forgejo: 'Forgejo', ado: 'Azure DevOps' };

const forgejoPath =
  'M16.7773 0c1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.1175a7.0759 7.0759 0 0 1 4.148-1.4205l.1176-.001 1.3385.0002c.4973-.8827 1.4434-1.4788 2.5288-1.4788 1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.319c.8827.4973 1.4788 1.4434 1.4788 2.5287 0 1.602-1.2986 2.9005-2.9005 2.9005-1.6018 0-2.9004-1.2986-2.9004-2.9005 0-1.0853.596-2.0314 1.4788-2.5287l-.0002-9.9831c0-3.887 3.1195-7.0453 6.9915-7.108l.1176-.001h1.3385C14.7458.5962 15.692 0 16.7773 0ZM7.2227 19.9052c-.6596 0-1.1943.5347-1.1943 1.1943s.5347 1.1943 1.1943 1.1943 1.1944-.5347 1.1944-1.1943-.5348-1.1943-1.1944-1.1943Zm9.5546-10.4644c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Zm0-7.7346c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Z';
const adoPath =
  'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z';

function Glyph({ path, size }: { path: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/** The distinguishing bit of a connection: organization, instance or account. */
export function serviceDetail(kind: ForgeKind, info: { host?: string | null; login?: string | null; org?: string | null }): string | null {
  if (kind === 'ado') return info.org ?? info.host ?? null;
  if (kind === 'forgejo') return info.host ?? null;
  return info.login ?? info.host ?? null;
}

/** The bare glyph, for use inside buttons and other labelled contexts. */
export function ServiceGlyph({ kind, size = 14 }: { kind: ForgeKind; size?: number }) {
  return kind === 'github' ? <MarkGithubIcon size={size} /> : <Glyph path={kind === 'forgejo' ? forgejoPath : adoPath} size={size} />;
}

export function ServiceIcon({ kind, detail, size = 14 }: { kind: ForgeKind; detail?: string | null; size?: number }) {
  const label = detail ? `${serviceNames[kind]}: ${detail}` : serviceNames[kind];
  return (
    <span className="service-icon" role="img" aria-label={label} title={label}>
      <ServiceGlyph kind={kind} size={size} />
    </span>
  );
}
