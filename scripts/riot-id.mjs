export function playerNameFromAccount(account) {
  const name = typeof account?.game_name === 'string' ? account.game_name.trim() : '';
  if (!name) return undefined;
  const tag = typeof account.tag_line === 'string' ? account.tag_line.trim() : '';
  return tag ? `${name}#${tag}` : name;
}
