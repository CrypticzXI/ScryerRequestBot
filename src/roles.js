import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';

/**
 * Two bot roles, created in every server the bot is in (needs Manage Roles):
 *  - Scryer Request: may use /request and request from discovery posts.
 *  - Scryer Manager: everything above, plus /discovery and /forcesearch.
 * Members with Administrator (and the server owner) always have full access.
 * Roles are matched by name, so they can be recoloured or reordered freely.
 */

export const Access = {
  REQUEST: 'request',
  MANAGER: 'manager',
};

export const ROLE_NAMES = {
  [Access.REQUEST]: process.env.REQUEST_ROLE_NAME?.trim() || 'Scryer Request',
  [Access.MANAGER]: process.env.MANAGER_ROLE_NAME?.trim() || 'Scryer Manager',
};

const ROLE_COLORS = { [Access.REQUEST]: 0x3b82f6, [Access.MANAGER]: 0x7c5cff };

async function ensureRoles(guild) {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  for (const access of [Access.MANAGER, Access.REQUEST]) {
    const name = ROLE_NAMES[access];
    if (guild.roles.cache.some((role) => role.name === name)) continue;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      console.warn(`Can't create the "${name}" role in ${guild.name}: the bot needs Manage Roles. Create it manually.`);
      continue;
    }
    try {
      await guild.roles.create({
        name,
        color: ROLE_COLORS[access],
        mentionable: false,
        reason: 'Scryer Request Bot access role',
      });
      console.log(`Created the "${name}" role in ${guild.name}.`);
    } catch (error) {
      console.warn(`Couldn't create the "${name}" role in ${guild.name}: ${error.message}`);
    }
  }
}

/** Creates missing roles in every current guild and in guilds the bot joins later. */
export function setupRoles(client) {
  for (const guild of client.guilds.cache.values()) ensureRoles(guild);
  client.on(Events.GuildCreate, (guild) => ensureRoles(guild));
}

function memberRoleNames(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return [];
  // Cached GuildMember -> RoleManager; uncached API member -> array of role IDs.
  if (Array.isArray(roles)) {
    return roles.map((id) => interaction.guild?.roles.cache.get(id)?.name).filter(Boolean);
  }
  return roles.cache.map((role) => role.name);
}

export function hasAccess(interaction, access) {
  if (!interaction.inGuild()) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (interaction.guild?.ownerId === interaction.user.id) return true;

  const names = memberRoleNames(interaction);
  if (names.includes(ROLE_NAMES[Access.MANAGER])) return true;
  return access === Access.REQUEST && names.includes(ROLE_NAMES[Access.REQUEST]);
}

export function accessDeniedMessage(access) {
  const roles =
    access === Access.MANAGER
      ? `**${ROLE_NAMES[Access.MANAGER]}**`
      : `**${ROLE_NAMES[Access.REQUEST]}** or **${ROLE_NAMES[Access.MANAGER]}**`;
  return `You need the ${roles} role (or Administrator) to do that.`;
}

/** Replies with an ephemeral "no access" message and returns false if the user lacks access. */
export async function requireAccess(interaction, access) {
  if (hasAccess(interaction, access)) return true;
  await interaction.reply({ content: accessDeniedMessage(access), flags: MessageFlags.Ephemeral });
  return false;
}
