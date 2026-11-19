// Agent mode: the AI Sidebar works visibly on the user's screen and its actions
// are approved automatically, except those that look destructive.
import { t } from './i18n';

/** Shell patterns that always need the user's confirmation, with a reason. */
const DANGER: [RegExp, string][] = [
  [/(^|[\s;&|(`])(rm|rmdir|unlink)\s/, 'menghapus file/folder'],
  [/\bfind\b[^|;&]*\s-delete\b/, 'menghapus file (find -delete)'],
  [/\b(shred|wipefs|mkfs(\.\w+)?|fdisk|parted|sgdisk)\b/, 'menghapus/memformat disk'],
  [/\bdd\b[^|;&]*\bof=/, 'menulis langsung ke disk/file (dd)'],
  [/>\s*\/dev\/(sd|nvme|vd|xvd|hd)/, 'menulis langsung ke disk'],
  [/\btruncate\b[^|;&]*-s\s*0\b/, 'mengosongkan file'],
  [/\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b/, 'mematikan/me-restart server'],
  [/\bsystemctl\s+(stop|restart|disable|mask|kill|reboot|poweroff|isolate)\b/, 'menghentikan/me-restart service'],
  [/\bservice\s+\S+\s+(stop|restart)\b/, 'menghentikan/me-restart service'],
  [/\b(kill\s+-9|pkill|killall)\b/, 'menghentikan proses'],
  [/\b(iptables|ip6tables|nft|ufw|firewall-cmd)\b(?![^|;&]*\s(status|-[LS]|-n?L|--list(-all)?|--state|list(-\w+)?|show)(\s|$))/, 'mengubah firewall'],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA|USER)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i, 'menghapus data database'],
  [/\b(dropdb|dropuser)\b|\bredis-cli\b[^|;&]*\bflush(all|db)\b/i, 'menghapus data database'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+(-f|--force)|branch\s+-D|checkout\s+--\s+\.|restore\s+\.)/, 'membuang perubahan git / force push'],
  [/\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|container\s+prune|image\s+prune)\b|\bdocker[\s-]compose\s+down\b[^|;&]*-v\b/, 'menghapus container/image/volume Docker'],
  [/\bkubectl\s+delete\b/, 'menghapus resource Kubernetes'],
  [/\b(chmod|chown)\s+-R\b[^|;&]*\s\/(\s|$|etc|usr|var|bin|lib|boot|home)\b/, 'mengubah izin file sistem secara rekursif'],
  [/\b(userdel|deluser|passwd|chpasswd|visudo)\b|\bcrontab\s+-r\b/, 'mengubah akun pengguna / cron'],
  [/\b(apt(-get)?|yum|dnf|zypper|pacman)\s+(remove|purge|autoremove|erase|-R)\b/, 'menghapus paket'],
  [/:\(\)\s*\{.*\};\s*:/, 'fork bomb'],
];

/** Returns why an action needs confirmation, or '' when it may run automatically. */
export function dangerReason(tool: string, args: any): string {
  let text = '';
  if (tool === 'run_command' || tool === 'run_background') text = String(args?.command ?? '');
  else if (tool === 'send_keys') text = String(args?.keys ?? '');
  else return '';
  for (const [re, why] of DANGER) if (re.test(text)) return t(why);
  return '';
}
