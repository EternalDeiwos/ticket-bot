import { Injectable, Logger } from '@nestjs/common';
import { uniq } from 'lodash';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildManager,
  PermissionsBitField,
  Snowflake,
  StringSelectMenuBuilder,
  ThreadChannel,
  channelMention,
  userMention,
} from 'discord.js';
import { EntityNotFoundError, InsertResult } from 'typeorm';
import { AuthError, InternalError, ValidationError } from 'src/errors';
import { CrewMemberAccess } from 'src/types';
import { DiscordService } from 'src/bot/discord.service';
import { GuildService } from 'src/core/guild/guild.service';
import { TicketTag } from 'src/core/tag/tag.service';
import { SelectGuild } from 'src/core/guild/guild.entity';
import { CrewService } from 'src/core/crew/crew.service';
import { CrewRepository } from 'src/core/crew/crew.repository';
import { CrewMemberService } from 'src/core/crew/member/crew-member.service';
import { Crew, SelectCrew } from 'src/core/crew/crew.entity';
import { TeamService } from 'src/core/team/team.service';
import { InsertTicket, SelectTicket, Ticket } from './ticket.entity';
import { TicketRepository } from './ticket.repository';
import { newTicketMessage, ticketTriageMessage } from './ticket.messages';

export const ticketProperties = {
  [TicketTag.ACCEPTED]: {
    color: 'DarkGreen',
    action: 'accepted',
    title: 'Ticket Accepted',
    tagsRemoved: [
      TicketTag.TRIAGE,
      TicketTag.DECLINED,
      TicketTag.ABANDONED,
      TicketTag.IN_PROGRESS,
      TicketTag.REPEATABLE,
      TicketTag.MOVED,
    ],
  },
  [TicketTag.DECLINED]: {
    color: 'DarkRed',
    action: 'declined',
    title: 'Ticket Declined',
    tagsRemoved: [
      TicketTag.TRIAGE,
      TicketTag.ACCEPTED,
      TicketTag.ABANDONED,
      TicketTag.DONE,
      TicketTag.MOVED,
    ],
  },
  [TicketTag.ABANDONED]: {
    color: 'LightGrey',
    action: 'closed',
    title: 'Ticket Abandoned',
    tagsRemoved: [TicketTag.DONE, TicketTag.DECLINED, TicketTag.MOVED],
  },
  [TicketTag.DONE]: {
    color: 'DarkGreen',
    action: 'completed',
    title: 'Ticket Done',
    tagsRemoved: [
      TicketTag.IN_PROGRESS,
      TicketTag.REPEATABLE,
      TicketTag.ABANDONED,
      TicketTag.DECLINED,
      TicketTag.MOVED,
    ],
  },
  [TicketTag.IN_PROGRESS]: {
    color: 'DarkGold',
    action: 'started',
    title: 'In Progress',
    tagsRemoved: [TicketTag.REPEATABLE, TicketTag.DONE, TicketTag.ABANDONED, TicketTag.MOVED],
  },
  [TicketTag.REPEATABLE]: {
    color: 'Aqua',
    action: 'marked repeatable',
    title: 'Repeatable Ticket / Chore',
    tagsRemoved: [TicketTag.IN_PROGRESS, TicketTag.DONE, TicketTag.ABANDONED, TicketTag.MOVED],
  },
  [TicketTag.MOVED]: {
    color: 'Aqua',
    action: 'moved',
    title: 'Moved',
    tagsRemoved: [
      TicketTag.TRIAGE,
      TicketTag.ACCEPTED,
      TicketTag.DECLINED,
      TicketTag.IN_PROGRESS,
      TicketTag.DONE,
      TicketTag.ABANDONED,
    ],
  },
};

export abstract class TicketService {
  abstract getTicket(ticket: SelectTicket): Promise<Ticket>;
  abstract createTicket(crewRef: SelectCrew, ticket?: InsertTicket): Promise<InsertResult>;

  // Move to Ticket Control
  abstract addMovePromptToTicket(thread: ThreadChannel): Promise<void>;

  // Move to Ticket Control
  abstract createMovePrompt(
    ticket: SelectTicket,
    exclude?: SelectCrew[],
  ): Promise<ActionRowBuilder<StringSelectMenuBuilder>>;

  // Move to Ticket Control
  abstract addTriageControlToThread(thread: ThreadChannel);

  // Move to Ticket Control
  abstract createTriageControl(
    ticket: SelectTicket,
    disabled?: { [K in 'accept' | 'decline' | 'close']?: boolean },
  ): ActionRowBuilder<ButtonBuilder>;

  abstract moveTicket(ticketRef: SelectTicket, ticketOverride: InsertTicket);
  abstract deleteTicket(ticketRef: SelectTicket, memberRef: Snowflake);

  // Move to Ticket Control
  abstract getActiveTicketControls(
    ticket: SelectTicket,
    disabled?: { [K in 'active' | 'repeat' | 'done' | 'close']?: boolean },
  ): ActionRowBuilder<ButtonBuilder>;

  abstract updateTicket(ticket: InsertTicket, tag: TicketTag, reason?: string): Promise<Ticket>;

  // Move to Ticket Control
  abstract sendIndividualStatus(
    crewRef: SelectCrew,
    targetChannelRef: Snowflake,
    memberRef: Snowflake,
  ): Promise<void>;

  // Move to Ticket Control
  abstract sendAllStatus(
    guildRef: SelectGuild,
    targetChannelRef: Snowflake,
    memberRef: Snowflake,
  ): Promise<void>;

  // Move to Ticket Control
  abstract createTicketButton(crewRef: Snowflake): ActionRowBuilder<ButtonBuilder>;

  // Move to Ticket Control
  abstract createCrewMenu(crews: Crew[]): ActionRowBuilder<StringSelectMenuBuilder>;
}

@Injectable()
export class TicketServiceImpl extends TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly guildManager: GuildManager,
    private readonly discordService: DiscordService,
    private readonly guildService: GuildService,
    private readonly crewService: CrewService,
    private readonly crewRepo: CrewRepository,
    private readonly ticketRepo: TicketRepository,
  ) {
    super();
  }

  async getTicket(ticketRef: SelectTicket) {
    try {
      return await this.ticketRepo.findOneOrFail({ where: ticketRef, withDeleted: true });
    } catch (err) {
      if (err instanceof EntityNotFoundError) {
        throw new ValidationError(
          'VALIDATION_FAILED',
          'This action can only be performed inside a ticket thread.',
        ).asDisplayable();
      }
    }
  }

  async createTicket(crewRef: SelectCrew, ticket?: InsertTicket) {
    const crew = await this.crewRepo.findOneOrFail({ where: crewRef, withDeleted: true });
    const discordGuild = await this.guildManager.fetch(crew.guild.guildSf);
    const forum = await discordGuild.channels.fetch(crew.team.forumSf);

    if (!forum || !forum.isThreadOnly()) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Invalid forum');
    }

    if (!ticket?.name || !ticket.content || !ticket.createdBy) {
      throw new ValidationError('VALIDATION_FAILED', 'Invalid ticket');
    }

    if (!ticket.updatedBy) {
      ticket.updatedBy = ticket.createdBy;
    }

    const triageTag = await crew.team.resolveSnowflakeFromTag(TicketTag.TRIAGE);
    const tags = await crew.team.tags;
    const crewTag = tags.find((tag) => tag.name === crew.shortName);
    const appliedTags: string[] = [];

    if (triageTag) {
      appliedTags.push(triageTag);
    }

    if (crewTag) {
      appliedTags.push(crewTag.tagSf);
    }

    const defaultTags = await crew.team.getDefaultTags();
    appliedTags.push(...defaultTags);

    const prompt = new EmbedBuilder()
      .setColor('DarkGold')
      .setTitle('New Ticket')
      .setDescription(ticketTriageMessage(ticket.createdBy, crew.roleSf));

    const embeds = [prompt];

    if (ticket.previousThreadSf) {
      const originalGuildRef = await this.ticketRepo.getOriginalGuild({
        threadSf: ticket.previousThreadSf,
      });

      if (originalGuildRef.id !== crew.guildId) {
        const originalGuild = await this.guildService.getGuild(originalGuildRef);
        const embed = new EmbedBuilder()
          .setColor('DarkGreen')
          .setTitle(`Incoming Request from ${originalGuild.name}`)
          .setDescription(
            `This ticket was moved from ${originalGuild.name}. The ticket author might not have joined the server yet so please be patient.`,
          );

        if (originalGuild.icon) {
          embed.setThumbnail(originalGuild.icon);
        }

        embeds.push(embed);
      }
    }

    const thread = await forum.threads.create({
      name: ticket.name,
      message: {
        content: newTicketMessage(ticket.content, ticket.createdBy, crew.roleSf),
        embeds,
        allowedMentions: {
          users: [ticket.createdBy],
          roles: crew.hasMovePrompt ? [] : [crew.roleSf],
        },
      },
      appliedTags,
    });

    const result = await this.ticketRepo.insert({
      ...ticket,
      threadSf: thread.id,
      guildId: crew.guildId,
    });

    if (crew.hasMovePrompt) {
      await this.addMovePromptToTicket(thread);
    }

    return result;
  }

  async addMovePromptToTicket(thread: ThreadChannel) {
    const ticket = await this.ticketRepo.findOneOrFail({
      where: { threadSf: thread.id },
      withDeleted: true,
    });

    const message = await thread.fetchStarterMessage();
    await message.edit({
      components: [
        await this.createMovePrompt({ threadSf: thread.id }, [{ crewSf: ticket.crewSf }]),
        this.createTriageControl(ticket, { accept: true }),
      ],
    });
  }

  async createMovePrompt(ticketRef: SelectTicket, exclude: SelectCrew[] = []) {
    const ticket = await this.ticketRepo.findOneOrFail({ where: ticketRef, withDeleted: true });
    const excludedCrewChannels = exclude.map((e) => e.crewSf);
    const crews = (await this.crewRepo.getShared(ticket.guild.guildSf, true).getMany()).filter(
      (crew) => !excludedCrewChannels.includes(crew.crewSf),
    );

    const select = new StringSelectMenuBuilder()
      .setCustomId(`ticket/move/${ticket.threadSf}`)
      .setPlaceholder('Select a crew')
      .setOptions(
        crews.map((crew) => {
          const teamName =
            crew.guild.guildSf !== ticket.guild.guildSf
              ? `[${crew.guild.shortName}] ${crew.team.name}`
              : crew.team.name;
          return { label: `${teamName}: ${crew.name}`, value: crew.crewSf };
        }),
      );

    if (!select.options.length) {
      select
        .addOptions({ label: 'placeholder', value: 'placeholder' })
        .setPlaceholder('No crews available')
        .setDisabled(true);
    }

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  }

  async addTriageControlToThread(thread: ThreadChannel) {
    const ticket = await this.ticketRepo.findOneOrFail({
      where: { threadSf: thread.id },
      withDeleted: true,
    });

    const message = await thread.fetchStarterMessage();
    await message.edit({
      components: [this.createTriageControl(ticket)],
    });
  }

  createTriageControl(
    ticket: Ticket,
    disabled: { [K in 'accept' | 'decline' | 'close']?: boolean } = {},
  ) {
    const accept = new ButtonBuilder()
      .setCustomId(`ticket/action/accept/${ticket.threadSf}`)
      .setLabel('Accept')
      .setDisabled(Boolean(disabled.accept))
      .setStyle(ButtonStyle.Success);

    const decline = new ButtonBuilder()
      // Decline is not an immediate action.
      // There is a form before the action is taken and is therefore handled differently
      .setCustomId(`ticket/reqdecline/${ticket.threadSf}`)
      .setLabel('Decline')
      .setDisabled(Boolean(disabled.decline))
      .setStyle(ButtonStyle.Danger);

    const close = new ButtonBuilder()
      .setCustomId(`ticket/action/close/${ticket.threadSf}`)
      .setLabel('Close')
      .setDisabled(Boolean(disabled.close))
      .setStyle(ButtonStyle.Secondary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(decline, accept, close);
  }

  async moveTicket(ticketRef: SelectTicket, ticketOverride: InsertTicket) {
    const ticket = await this.ticketRepo.findOneOrFail({
      where: ticketRef,
      withDeleted: true,
    });

    const result = await this.createTicket(
      { crewSf: ticketOverride.crewSf },
      {
        name: ticket.name,
        content: ticket.content,
        ...ticketOverride,
        createdBy: ticket.createdBy,
        previousThreadSf: ticket.threadSf,
      },
    );

    await this.updateTicket({ ...ticketRef, updatedBy: ticketOverride.updatedBy }, TicketTag.MOVED);
  }

  async deleteTicket(ticketRef: SelectTicket, memberRef: Snowflake) {
    const ticket = await this.ticketRepo.findOneOrFail({
      where: ticketRef,
      withDeleted: true,
    });

    const discordGuild = await this.guildManager.fetch(ticket.guild.guildSf);
    const guildMember = await discordGuild.members.fetch(memberRef);
    const forum = await discordGuild.channels.fetch(ticket.crew.team.forumSf);

    if (!forum || !forum.isThreadOnly()) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Invalid forum');
    }

    const thread = await forum.threads.fetch(ticket.threadSf);
    const now = new Date();

    const embed = new EmbedBuilder()
      .setTitle('Ticket Closed')
      .setColor('DarkRed')
      .setDescription(`Your ticket was closed by ${guildMember}`)
      .setThumbnail(guildMember.avatarURL() ?? guildMember.user.avatarURL());

    await thread.send({ embeds: [embed] });
    await thread.setLocked(true);
    await thread.setArchived(true);

    return await this.ticketRepo.updateReturning(ticketRef, {
      deletedAt: now,
      updatedBy: guildMember.id,
      updatedAt: now,
    });
  }

  getActiveTicketControls(
    ticket: Ticket,
    disabled: { [K in 'active' | 'repeat' | 'done' | 'close']?: boolean } = {},
  ) {
    const inProgress = new ButtonBuilder()
      .setCustomId(`ticket/action/active/${ticket.threadSf}`)
      .setLabel('In Progress')
      .setDisabled(Boolean(disabled.active))
      .setStyle(ButtonStyle.Primary);

    const repeatable = new ButtonBuilder()
      .setCustomId(`ticket/action/repeat/${ticket.threadSf}`)
      .setLabel('Repeatable')
      .setDisabled(Boolean(disabled.repeat))
      .setStyle(ButtonStyle.Secondary);

    const done = new ButtonBuilder()
      .setCustomId(`ticket/action/done/${ticket.threadSf}`)
      .setLabel('Done')
      .setDisabled(Boolean(disabled.done))
      .setStyle(ButtonStyle.Success);

    const close = new ButtonBuilder()
      .setCustomId(`ticket/action/close/${ticket.threadSf}`)
      .setLabel('Close')
      .setDisabled(Boolean(disabled.close))
      .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(inProgress, repeatable, done, close);
  }

  async updateTicket(data: InsertTicket, tag: TicketTag, reason?: string): Promise<Ticket> {
    if (!data.updatedBy) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Ticket updates must provide updatedBy');
    }

    const ticket = await this.ticketRepo.findOne({
      where: { threadSf: data.threadSf },
      withDeleted: true,
    });

    const discordGuild = await this.guildManager.fetch(ticket.guild.guildSf);
    const member = await discordGuild.members.fetch(data.updatedBy);
    const forum = await discordGuild.channels.fetch(ticket.crew.team.forumSf);

    if (!forum || !forum.isThreadOnly()) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Invalid forum');
    }

    const thread = await forum.threads.fetch(ticket.threadSf);

    const result = await this.ticketRepo.updateReturning(
      { threadSf: data.threadSf },
      { ...data, updatedAt: new Date() },
    );

    const { title, color, action, tagsRemoved } = ticketProperties[tag];
    const tagSnowflakeMap = await ticket.crew.team.getSnowflakeMap();
    const tagsRemovedSf = tagsRemoved.map((tagName) => tagSnowflakeMap[tagName]);
    const tagAdd = tagSnowflakeMap[tag];

    const message =
      reason &&
      reason
        .split('\n')
        .map((r) => `> ${r}`)
        .join('\n');
    const description = `Your ticket ${channelMention(thread.id)} was ${action} by ${member}`;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setDescription(description + ((reason && ` for the following reason:\n\n${message}`) || ''))
      .setThumbnail(member.avatarURL() ?? member.user.avatarURL());

    await thread.send({
      content: ticket.createdBy !== member.id ? userMention(ticket.createdBy) : '',
      allowedMentions: { users: [ticket.createdBy] },
      embeds: [embed],
    });

    const starterMessage = await thread.fetchStarterMessage();
    switch (tag) {
      case TicketTag.TRIAGE:
        await starterMessage.edit({
          components: [this.createTriageControl(ticket)],
        });
        break;

      case TicketTag.ACCEPTED:
        await starterMessage.edit({
          components: [this.getActiveTicketControls(ticket)],
        });
        break;

      case TicketTag.DECLINED:
      case TicketTag.ABANDONED:
      case TicketTag.DONE:
      case TicketTag.MOVED:
        await starterMessage.edit({
          components: [],
        });
        break;

      case TicketTag.IN_PROGRESS:
        await starterMessage.edit({
          components: [this.getActiveTicketControls(ticket, { active: true })],
        });
        break;

      case TicketTag.REPEATABLE:
        await starterMessage.edit({
          components: [
            this.getActiveTicketControls(ticket, { active: true, repeat: true, close: true }),
          ],
        });
        break;
    }

    try {
      await thread.setAppliedTags(
        uniq([...thread.appliedTags.filter((tag) => !tagsRemovedSf.includes(tag)), tagAdd]),
      );
    } catch (err) {
      this.logger.error(
        `Failed to apply tags to ${ticket.name} in ${discordGuild.name}: ${err.message}`,
        err.stack,
      );
    }

    if (
      [TicketTag.DONE, TicketTag.ACCEPTED, TicketTag.DECLINED, TicketTag.IN_PROGRESS].includes(
        tag,
      ) &&
      member.id !== ticket.createdBy
    ) {
      try {
        const creator = await thread.guild.members.fetch(ticket.createdBy);
        const dm = await creator.createDM();

        await dm.send({
          embeds: [embed],
        });
      } catch (err) {
        this.logger.error(
          `Failed to DM ticket creator for ${ticket.name} in ${discordGuild.name}: ${err.message}`,
          err.stack,
        );
      }
    }

    if (result?.affected) {
      return (result?.raw as Ticket[]).pop();
    }
  }

  public async sendIndividualStatus(
    crewRef: SelectCrew,
    targetChannelRef: Snowflake,
    memberRef: Snowflake,
  ) {
    const crew = await this.crewService.getCrew(crewRef);
    const discordGuild = await this.guildManager.fetch(crew.guild.guildSf);
    const crewChannel = await discordGuild.channels.fetch(crew.crewSf);

    if (!crewChannel.permissionsFor(memberRef).has(PermissionsBitField.Flags.ViewChannel, true)) {
      throw new AuthError('FORBIDDEN', 'You do not have access to that crew').asDisplayable();
    }

    const targetChannel = await discordGuild.channels.fetch(targetChannelRef);

    if (!targetChannel || !targetChannel.isTextBased()) {
      throw new ValidationError('VALIDATION_FAILED', 'Invalid channel').asDisplayable();
    }

    if (crew.isSecureOnly && !(await this.discordService.isChannelPrivate(targetChannel))) {
      throw new AuthError('FORBIDDEN', 'This channel is not secure').asDisplayable();
    }

    const tickets = await crew.tickets;
    const members = await crew.members;
    const owner = members.find((member) => member.access === CrewMemberAccess.OWNER);
    const embed = new EmbedBuilder()
      .setTitle(`Tickets: ${crew.name}`)
      .setColor('DarkGreen')
      .setThumbnail(discordGuild.iconURL())
      .setTimestamp()
      .setDescription(
        `${channelMention(crew.crewSf)} is led by ${owner ? userMention(owner.memberSf) : 'nobody'}.`,
      );

    if (tickets.length) {
      embed.setFields([
        {
          name: 'Active Tickets',
          value: tickets
            .map(
              (ticket) =>
                `- ${channelMention(ticket.threadSf)} from ${userMention(ticket.createdBy)}`,
            )
            .join('\n'),
        },
      ]);
    } else {
      embed.setFields([
        {
          name: 'Active Tickets',
          value: 'None',
        },
      ]);
    }

    if (targetChannel.id === crew.crewSf) {
      await targetChannel.send({
        embeds: [embed],
        components: [this.crewService.createCrewActions()],
      });
    } else {
      await targetChannel.send({ embeds: [embed] });
    }
  }

  public async sendAllStatus(
    guildRef: SelectGuild,
    targetChannelRef: Snowflake,
    memberRef: Snowflake,
  ) {
    const guild = await this.guildService.getGuild(guildRef);
    const discordGuild = await this.guildManager.fetch(guild.guildSf);
    const member = await discordGuild.members.fetch(memberRef);
    const targetChannel = await discordGuild.channels.fetch(targetChannelRef);

    if (!targetChannel || !targetChannel.isTextBased()) {
      throw new ValidationError('VALIDATION_FAILED', 'Invalid channel').asDisplayable();
    }

    const targetChannelSecure = await this.discordService.isChannelPrivate(targetChannel);
    const crews = await this.crewRepo.find({ where: { guildId: guild.id } });

    const embed = new EmbedBuilder()
      .setTitle('Ticket Status')
      .setColor('DarkGreen')
      .setThumbnail(discordGuild.iconURL())
      .setTimestamp();

    const crewSummary: string[] = [];
    const fields: { name: string; value: string }[] = [];

    for (const crew of crews) {
      const crewChannel = await discordGuild.channels.fetch(crew.crewSf);

      if (
        !crewChannel.permissionsFor(member).has(PermissionsBitField.Flags.ViewChannel) ||
        (crew.isSecureOnly && !targetChannelSecure)
      ) {
        continue;
      }

      const members = await crew.members;
      const tickets = await crew.tickets;
      const owner = members.find((member) => member.access === CrewMemberAccess.OWNER);

      crewSummary.push(
        `- ${channelMention(crew.crewSf)} (${members.length} members) led by ${owner ? userMention(owner.memberSf) : 'nobody'}`,
      );

      for (const ticket of tickets) {
        crewSummary.push(`  - ${channelMention(ticket.threadSf)}`);
      }
    }

    const content = crewSummary.join('\n');
    if (content.length) {
      embed.setDescription(content);
    } else {
      embed.setDescription('None');
    }

    embed.addFields(...fields);

    await targetChannel.send({ embeds: [embed] });
  }

  createTicketButton(crewRef: Snowflake) {
    const create = new ButtonBuilder()
      .setCustomId(`ticket/start/${crewRef}`)
      .setLabel('Create Ticket')
      .setStyle(ButtonStyle.Primary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(create);
  }

  createCrewMenu(crews: Crew[]) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('ticket/start')
      .setPlaceholder('Select a crew')
      .setOptions(
        crews.map((crew) => ({
          label: `${crew.team.name}: ${crew.name}`,
          value: crew.crewSf,
        })),
      );

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  }
}
