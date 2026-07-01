import type { SafetyConfig } from '../config/schema';
import type { AutonomyPreset } from '../plans/PlanActEngine';

export type ApprovalMode = NonNullable<SafetyConfig['approvalMode']>;

function deriveApprovalFlags(mode: ApprovalMode): Pick<
  SafetyConfig,
  'approvalMode' | 'requireApprovalForWrites' | 'requireApprovalForShell'
> {
  switch (mode) {
    case 'review_all':
      return { approvalMode: mode, requireApprovalForWrites: true, requireApprovalForShell: true };
    case 'ask_edits':
      return { approvalMode: mode, requireApprovalForWrites: true, requireApprovalForShell: false };
    case 'ask_deletes':
      return { approvalMode: mode, requireApprovalForWrites: false, requireApprovalForShell: false };
    case 'ask_commands':
      return { approvalMode: mode, requireApprovalForWrites: false, requireApprovalForShell: true };
    case 'auto':
      return { approvalMode: mode, requireApprovalForWrites: false, requireApprovalForShell: false };
  }
}

/** Apply network / danger limits from preset; approval gates come from approvalMode. */
export function resolveEffectiveSafety(config: SafetyConfig): SafetyConfig {
  const preset = (config.autonomyPreset ?? 'guided') as AutonomyPreset;
  const presetApplied = applyAutonomyPreset(config, preset);
  const approvalMode = (config.approvalMode ?? presetApplied.approvalMode ?? 'review_all') as ApprovalMode;
  return {
    ...presetApplied,
    ...deriveApprovalFlags(approvalMode),
  };
}

export function applyAutonomyPreset(base: SafetyConfig, preset: AutonomyPreset): SafetyConfig {
  switch (preset) {
    case 'safe':
      return {
        ...base,
        requireApprovalForWrites: true,
        requireApprovalForShell: true,
        blockDangerousCommands: true,
        allowNetwork: false,
        approvalMode: 'review_all',
      };
    case 'guided':
      return {
        ...base,
        requireApprovalForWrites: true,
        requireApprovalForShell: true,
        blockDangerousCommands: true,
        allowNetwork: true,
        approvalMode: 'ask_edits',
      };
    case 'builder':
      return {
        ...base,
        requireApprovalForWrites: false,
        requireApprovalForShell: true,
        blockDangerousCommands: true,
        allowNetwork: true,
        approvalMode: 'ask_commands',
      };
    case 'pilot':
      return {
        ...base,
        requireApprovalForWrites: false,
        requireApprovalForShell: true,
        blockDangerousCommands: true,
        allowNetwork: true,
        approvalMode: base.approvalMode === 'review_all' ? 'ask_commands' : base.approvalMode,
      };
    case 'enterprise':
      return {
        ...base,
        requireApprovalForWrites: true,
        requireApprovalForShell: true,
        blockDangerousCommands: true,
        allowNetwork: false,
        approvalMode: 'review_all',
      };
    default:
      return base;
  }
}

export function describeAutonomyPreset(preset: AutonomyPreset): string {
  switch (preset) {
    case 'safe':
      return 'Strictest: all edits and commands need approval, no network.';
    case 'guided':
      return 'Balanced: asks before file edits; read-only shell and fetch_web allowed.';
    case 'builder':
      return 'Fast iteration: auto-approves writes; mutating shell still needs approval.';
    case 'pilot':
      return 'High autonomy: auto-approves writes; shell commands still reviewed.';
    case 'enterprise':
      return 'Locked down: no network, all operations require approval.';
    default:
      return '';
  }
}
