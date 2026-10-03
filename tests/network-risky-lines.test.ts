import { describe, expect, it } from "bun:test";
import { aiIsWriteCommand, classifyLine, commandIsDangerous, dangerReason, isDangerousLine } from "../src/network/risky-lines";

// Ported from GreenCLI (src/utils/configSafety.test.ts and riskyLines.test.ts): the copied checker gives the same
// verdicts in Casper. isRiskyCommand stands for GreenCLI's commandRisk: a change or a dangerous line.
const isRiskyCommand = (line: string) => ["change", "dangerous"].includes(classifyLine(line).kind);

describe('isDangerousLine', () => {
  it('flags shutdown, but not its "no" negation', () => {
    expect(isDangerousLine('shutdown')).toBe(true);
    expect(isDangerousLine('  shutdown')).toBe(true);
    expect(isDangerousLine('neighbor 10.0.0.2 shutdown')).toBe(true);
    expect(isDangerousLine('ip ospf shutdown')).toBe(true);
    expect(isDangerousLine('no shutdown')).toBe(false);
    expect(isDangerousLine('  no shutdown')).toBe(false);
    expect(isDangerousLine('no ip ospf shutdown')).toBe(false);
    expect(isDangerousLine('NO SHUTDOWN')).toBe(false);
  });

  it('ignores the dangerous words inside names, descriptions, and quoted text', () => {
    expect(isDangerousLine('description shutdown after cutover')).toBe(false);
    expect(isDangerousLine('description Reload test port')).toBe(false);
    expect(isDangerousLine('set interfaces ge-0/0/0 description "reboot me"')).toBe(false);
    expect(isDangerousLine('name erase-later')).toBe(false);
    expect(isDangerousLine('vlan 10 name shutdown-vlan')).toBe(false);
    expect(isDangerousLine('interface lag 1 reload-delay 10')).toBe(false);
  });

  it('flags erase / reload / reboot but not reload cancel', () => {
    expect(isDangerousLine('erase startup-config')).toBe(true);
    expect(isDangerousLine('write erase')).toBe(true);
    expect(isDangerousLine('do reload')).toBe(true);
    expect(isDangerousLine('reload at 23:00')).toBe(true);
    expect(isDangerousLine('reload cancel')).toBe(false);
    expect(isDangerousLine('request system reboot')).toBe(true);
    expect(isDangerousLine('request system zeroize')).toBe(true);
    expect(isDangerousLine('boot system primary')).toBe(true);
    expect(isDangerousLine('boot set-default flash primary')).toBe(false);
  });

  it('treats the normal save step as safe but overwriting config from elsewhere as risky', () => {
    expect(isDangerousLine('copy running-config startup-config')).toBe(false);
    expect(isDangerousLine('copy run start')).toBe(false);
    expect(isDangerousLine('write memory')).toBe(false);
    expect(isDangerousLine('commit')).toBe(false);
    expect(isDangerousLine('copy tftp://10.0.0.5/sw.cfg startup-config')).toBe(true);
    expect(isDangerousLine('copy startup-config running-config')).toBe(true);
    expect(isDangerousLine('copy checkpoint before-change running-config')).toBe(true);
  });

  it('handles Junos deletes precisely', () => {
    expect(isDangerousLine('delete')).toBe(true);
    expect(isDangerousLine('delete system')).toBe(true);
    expect(isDangerousLine('delete system services ssh')).toBe(true);
    expect(isDangerousLine('delete system login user bob')).toBe(true);
    expect(isDangerousLine('delete system syslog host 10.0.0.9')).toBe(false);
    expect(isDangerousLine('delete vlans GUEST')).toBe(true); // like `no vlan N`: removes the VLAN
    expect(isDangerousLine('load override terminal')).toBe(true);
    expect(isDangerousLine('set interfaces ge-0/0/1 disable')).toBe(true);
    expect(isDangerousLine('set interfaces ge-0/0/1 description disable-me')).toBe(false);
  });

  it('flags removing interfaces, VLANs, and routing processes', () => {
    expect(isDangerousLine('no interface lag 1')).toBe(true);
    expect(isDangerousLine('no vlan 20')).toBe(true);
    expect(isDangerousLine('no vlan access 20')).toBe(false);
    expect(isDangerousLine('no router bgp 65001')).toBe(true);
    expect(isDangerousLine('vlan access 20')).toBe(false);
  });
});

describe('dangerReason', () => {
  it('says what each kind of risky line does, in plain words', () => {
    for (const [line, reason] of [
      ['erase startup-config', 'erases the config or storage'],
      ['write erase', 'erases the saved config'],
      ['request system zeroize', 'wipes the device back to factory state'],
      ['do reload', 'reboots the switch'],
      ['request system reboot', 'reboots or powers off the device'],
      ['boot system primary', 'reboots the switch'],
      ['delete', 'deletes the whole candidate config'],
      ['load override terminal', 'replaces the whole config'],
      ['delete system services ssh', 'removes management access (SSH, logins or the root password)'],
      ['shutdown', 'shuts it down'],
      ['set interfaces ge-0/0/1 disable', 'disables the interface'],
      ['deactivate interfaces ge-0/0/1', 'deactivates interfaces'],
      ['no interface 1/1/1', 'removes the interface'],
      ['no vlan 10', 'removes the VLAN'],
      ['no router ospf', 'removes the routing process'],
      ['copy tftp://10.0.0.5/cfg startup-config', 'overwrites the config from another copy'],
    ] as const) {
      expect([line, dangerReason(line)]).toEqual([line, reason]);
    }
  });

  it('is undefined exactly when isDangerousLine is false', () => {
    for (const line of ['no shutdown', 'reload cancel', 'copy running-config startup-config', 'commit', 'description shutdown after cutover', 'show version']) {
      expect([line, dangerReason(line)]).toEqual([line, undefined]);
      expect(isDangerousLine(line)).toBe(false);
    }
  });
});

// One verdict per line, shared by the AI gate, multi-device sends and the Config Editor.
const kind = (line: string) => classifyLine(line).kind;

describe('riskyLines: one verdict for every check', () => {
  it('no shutdown brings a port up: a change, not dangerous', () => {
    expect(kind('no shutdown')).toBe('change');
    expect(isRiskyCommand('no shutdown')).toBe(true);
    expect(dangerReason('no shutdown')).toBeUndefined();
  });

  it('a peer or protocol shutdown anywhere in the line is dangerous', () => {
    expect(kind('neighbor 10.0.0.2 shutdown')).toBe('dangerous');
    expect(kind('ip ospf shutdown')).toBe('dangerous');
    expect(isRiskyCommand('neighbor 10.0.0.2 shutdown')).toBe(true);
  });

  it('free text is never a command: a description that says reload is a plain config line', () => {
    expect(kind('description Reload test port')).toBe('config');
    expect(isRiskyCommand('description Reload test port')).toBe(false);
    expect(commandIsDangerous('description Reload test port')).toBe(false);
  });

  it('saving is a change, not dangerous', () => {
    for (const line of ['write memory', 'copy running-config startup-config']) {
      expect(kind(line)).toBe('change');
      expect(commandIsDangerous(line)).toBe(false);
    }
  });

  it('commit is a change; rollback, install, upgrade and clear are dangerous', () => {
    expect(kind('commit')).toBe('change');
    expect(kind('rollback 1')).toBe('dangerous');
    expect(kind('rollback 0')).toBe('change'); // only throws away the uncommitted edits
    expect(kind('install')).toBe('dangerous');
    expect(kind('request system software add /var/tmp/junos.tgz')).toBe('dangerous');
    expect(kind('upgrade')).toBe('dangerous');
    expect(kind('clear ip bgp *')).toBe('dangerous');
    expect(kind('clear counters')).toBe('dangerous');
  });

  it('reload cancel and boot set-default are changes', () => {
    expect(kind('reload cancel')).toBe('change');
    expect(kind('boot set-default flash primary')).toBe('change');
  });

  it('Junos disable, deactivate and load override are dangerous', () => {
    expect(kind('set interfaces ge-0/0/0 disable')).toBe('dangerous');
    expect(kind('deactivate interfaces ge-0/0/0')).toBe('dangerous');
    expect(kind('load override terminal')).toBe('dangerous');
    expect(isRiskyCommand('set interfaces ge-0/0/0 disable')).toBe(true);
  });

  it('Junos delete of interfaces or VLANs is dangerous', () => {
    expect(kind('delete interfaces ge-0/0/0')).toBe('dangerous');
    expect(kind('delete vlans users')).toBe('dangerous');
    expect(kind('delete system syslog')).toBe('change');
  });

  it('a read verb wins over a risky word in its filter', () => {
    expect(kind('show running-config | include reload')).toBe('read');
    expect(aiIsWriteCommand('show running-config | include reload')).toBe(false);
    // A file-writing pipe is never a read.
    expect(aiIsWriteCommand('show log messages | save /var/log/messages')).toBe(true);
    // Nor is a chain: the second command could be anything.
    expect(aiIsWriteCommand('cat /etc/hosts; reboot')).toBe(true);
    expect(aiIsWriteCommand('uptime && reboot')).toBe(true);
  });

  it('halt and power-off are dangerous, and the AI dialog says so', () => {
    expect(kind('halt')).toBe('dangerous');
    expect(kind('request system power-off')).toBe('dangerous');
    expect(commandIsDangerous('show version\nhalt')).toBe(true);
  });

  it('the AI gate still asks about anything it cannot tell is a read', () => {
    expect(aiIsWriteCommand('interface 1/1/1')).toBe(true);
    expect(kind('interface 1/1/1')).toBe('config');
    expect(isRiskyCommand('interface 1/1/1')).toBe(false);
  });
});

describe('review: the AI gate never lets a hidden second command or a non-filter pipe pass as a read', () => {
  it('asks for every chain, background job, process substitution and shell', () => {
    for (const cmd of [
      'ping -c1 x & reboot', 'dir & format c: /q', 'cat /etc/hosts | xargs reboot', 'echo y | sudo reboot',
      'head x | delete', 'ping 1.1.1.1 | install', 'get system | reload', 'cat <(reboot)', 'sh -c "reboot"',
      'sh install.sh', 'show version; reload', 'show reload',
    ]) expect({ cmd, write: aiIsWriteCommand(cmd) }).toEqual({ cmd, write: true });
  });

  it('keeps real reads with filters as reads', () => {
    for (const cmd of [
      'show running-config | include reload', 'sh run | i shutdown', 'show interfaces | match down | count',
      'show log messages | last 20', 'cat /var/log/syslog | grep error', 'display current-configuration | include vlan',
    ]) expect({ cmd, write: aiIsWriteCommand(cmd) }).toEqual({ cmd, write: false });
  });

  it('a read with a risky word in its filter is a read for every check', () => {
    for (const line of ['show interface | include shutdown', 'show log | include zeroize', 'show run | include clear']) {
      expect(kind(line)).toBe('read');
      expect(isRiskyCommand(line)).toBe(false);
    }
  });
});

describe('review: wipes and reboots keep their danger styling', () => {
  it('flags format, filesystem deletes, factory resets and shell reboots', () => {
    for (const cmd of [
      'format flash:', 'delete flash:vlan.dat', 'delete /force nvram:startup-config', 'factory-reset', 'factory-default',
      'sudo reboot', 'systemctl reboot', 'show ver; reload',
    ]) expect({ cmd, danger: commandIsDangerous(cmd) }).toEqual({ cmd, danger: true });
  });

  it('does not flag clearing the screen or the Linux install tool', () => {
    expect(kind('clear')).not.toBe('dangerous');
    expect(kind('clear screen')).not.toBe('dangerous');
    expect(kind('install -m 644 a b')).not.toBe('dangerous');
    expect(kind('clear counters')).toBe('dangerous');
  });
});
