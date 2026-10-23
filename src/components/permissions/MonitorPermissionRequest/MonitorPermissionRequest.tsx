import React from 'react';
import { BashTool } from '../../../tools/BashTool/BashTool.js';
import { BashPermissionRequest } from '../BashPermissionRequest/BashPermissionRequest.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';

/**
 * Monitor runs a shell command under the same permission rules as Bash, so its
 * dialog is the Bash one. The Bash dialog parses the input with Bash's schema,
 * which would reject Monitor's extra fields; it gets a view reduced to
 * command + description, and approvals are mapped back to the original input.
 */
export function MonitorPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const original = props.toolUseConfirm;
  const input = original.input as {
    command: string;
    description?: string;
  };
  const view = {
    ...original,
    tool: BashTool,
    input: {
      command: input.command,
      description: input.description
    },
    onAllow: (_ignored: unknown, ...rest: unknown[]) => (original.onAllow as (...a: unknown[]) => void)(original.input, ...rest)
  };
  return <BashPermissionRequest {...props} toolUseConfirm={view as never} />;
}
