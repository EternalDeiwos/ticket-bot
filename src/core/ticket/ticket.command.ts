import { Injectable, Logger, UseFilters, UseInterceptors } from '@nestjs/common';
import {
  Button,
  ButtonContext,
  ComponentParam,
  Context,
  MessageCommand,
  MessageCommandContext,
  Modal,
  ModalContext,
  ModalParam,
  Options,
  SelectedStrings,
  SlashCommandContext,
  StringOption,
  StringSelect,
  StringSelectContext,
  Subcommand,
  TargetMessage,
} from 'necord';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildChannelResolvable,
  Message,
  ModalBuilder,
  Snowflake,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { InternalError } from 'src/errors';
import { BotService } from 'src/bot/bot.service';
import { PromptEmbed, SuccessEmbed } from 'src/bot/embed';
import { EchoCommand } from 'src/core/echo.command-group';
import { DiscordExceptionFilter } from 'src/bot/bot-exception.filter';
import { GuildService } from 'src/core/guild/guild.service';
import { CrewRepository } from 'src/core/crew/crew.repository';
import { TicketTag } from 'src/core/tag/tag.service';
import { SelectCrewCommandParams } from 'src/core/crew/crew.command';
import { CrewSelectAutocompleteInterceptor } from 'src/core/crew/crew-select.interceptor';
import { TicketService } from './ticket.service';
import { TicketRepository } from './ticket.repository';
import {
  crewPromptStatusInstructions,
  proxyTicketMessage,
  ticketPromptCrewCreateInstructions,
  ticketPromptCrewJoinInstructions,
  ticketPromptDescription,
  ticketPromptStatusInstructions,
  ticketPromptTriageHelp,
} from './ticket.messages';

export const TicketActionToTag: Record<string, TicketTag> = {
  accept: TicketTag.ACCEPTED,
  decline: TicketTag.DECLINED,
  active: TicketTag.IN_PROGRESS,
  repeat: TicketTag.REPEATABLE,
  done: TicketTag.DONE,
  close: TicketTag.ABANDONED,
};

export class TicketDeclineReasonCommandParams {
  @StringOption({
    name: 'reason',
    description: 'Provide a reason',
    required: true,
  })
  reason: string;
}

@Injectable()
@EchoCommand({
  name: 'ticket',
  description: 'Manage tickets',
})
@UseFilters(DiscordExceptionFilter)
export class TicketCommand {
  private readonly logger = new Logger(TicketCommand.name);

  constructor(
    private readonly botService: BotService,
    private readonly guildService: GuildService,
    private readonly crewRepo: CrewRepository,
    private readonly ticketService: TicketService,
    private readonly ticketRepo: TicketRepository,
  ) {}

  @UseInterceptors(CrewSelectAutocompleteInterceptor)
  @Subcommand({
    name: 'prompt',
    description: 'Create a form to start the ticket wizard',
    dmPermission: false,
  })
  async onPrompt(
    @Context() [interaction]: SlashCommandContext,
    @Options() data: SelectCrewCommandParams,
  ) {
    try {
      BigInt(data.crew);
    } catch {
      return interaction.reply({ ephemeral: true, content: 'Invalid crew selected' });
    }

    const prompt = new EmbedBuilder()
      .setColor('DarkGold')
      .setTitle('Create a Ticket')
      .setDescription(ticketPromptDescription())
      .addFields(
        {
          name: 'Triage Process',
          value: ticketPromptTriageHelp(),
          inline: false,
        },
        {
          name: 'Crews',
          value: ticketPromptCrewJoinInstructions(),
          inline: false,
        },
        {
          name: 'Crew Status',
          value: crewPromptStatusInstructions(),
          inline: false,
        },
        {
          name: 'Ticket Status',
          value: ticketPromptStatusInstructions(),
          inline: false,
        },
        {
          name: 'Create a Crew',
          value: ticketPromptCrewCreateInstructions(),
          inline: false,
        },
      );

    const maybeCrew = await this.crewRepo.findOne({ where: { crewSf: data.crew } });

    // Use selected crew
    if (data.crew) {
      const crew = await this.crewRepo.findOne({ where: { crewSf: data.crew } });

      if (!crew) {
        return interaction.reply({ content: 'Invalid crew', ephemeral: true });
      }

      const create = new ButtonBuilder()
        .setCustomId(`ticket/start/${data.crew}`)
        .setLabel('Create Ticket')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(create);

      await interaction.channel.send({
        components: [this.ticketService.createTicketButton(data.crew)],
        embeds: [prompt],
      });
      // Try infer crew from interaction channel
    } else if (maybeCrew) {
      await interaction.channel.send({
        components: [this.ticketService.createTicketButton(maybeCrew.crewSf)],
        embeds: [prompt],
      });

      // Show global ticket status
    } else {
      prompt.setDescription(ticketPromptDescription(true));
      const crews = await this.crewRepo.find({
        where: { guild: { guildSf: interaction.guildId } },
      });

      await interaction.channel.send({
        components: [this.ticketService.createCrewMenu(crews)],
        embeds: [prompt],
      });
    }

    return interaction.reply({ content: 'Done', ephemeral: true });
  }

  @UseInterceptors(CrewSelectAutocompleteInterceptor)
  @Subcommand({
    name: 'new',
    description: 'Create a new ticket',
    dmPermission: false,
  })
  async onNewTicketCommand(
    @Context() [interaction]: SlashCommandContext,
    @Options() data: SelectCrewCommandParams,
  ) {
    return interaction.showModal(
      this.buildTicketModal(data.crew ? data.crew : interaction.channelId),
    );
  }

  @Button('ticket/start/:crew')
  async onCrewTicketStart(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('crew') channelRef: Snowflake,
  ) {
    const modal = this.buildTicketModal(channelRef);
    return interaction.showModal(modal);
  }

  @StringSelect('ticket/start')
  async onTicketStart(
    @Context() [interaction]: StringSelectContext,
    @SelectedStrings() [selected]: string[],
  ) {
    const modal = this.buildTicketModal(selected);
    return interaction.showModal(modal);
  }

  @MessageCommand({
    name: 'Create Ticket',
    dmPermission: false,
  })
  async onTicketStartForMessage(
    @Context() [interaction]: MessageCommandContext,
    @TargetMessage() message: Message,
  ) {
    const guild = message.guild;
    const submitter = await guild.members.fetch(interaction.user);
    const author = await guild.members.fetch(message.author);
    const modal = this.buildTicketModal(message.channel.id, {
      what: proxyTicketMessage(
        message.content,
        submitter.id,
        author.id,
        message.channelId,
        message.id,
      ),
    });
    interaction.showModal(modal);
  }

  buildTicketModal(
    channelRef: GuildChannelResolvable,
    values: {
      title?: string;
      what?: string;
      where?: string;
      when?: string;
    } = {},
    emoji: {
      title?: string;
      what?: string;
      where?: string;
      when?: string;
    } = {},
  ) {
    const titleInput = new TextInputBuilder()
      .setCustomId('ticket/form/title')
      .setLabel((emoji.title ? `${emoji.title} ` : '') + 'Title')
      .setPlaceholder('Summary of your request')
      .setValue(values.title || '')
      .setStyle(TextInputStyle.Short);

    const whatInput = new TextInputBuilder()
      .setCustomId('ticket/form/what')
      .setLabel((emoji.what ? `${emoji.what} ` : '') + 'What do you need?')
      .setPlaceholder(
        'Please be as detailed as possible and use exact quantities to prevent delays.',
      )
      .setValue(values.what || '')
      .setStyle(TextInputStyle.Paragraph);

    const whereInput = new TextInputBuilder()
      .setCustomId('ticket/form/where')
      .setLabel((emoji.where ? `${emoji.where} ` : '') + 'Where do you need it?')
      .setValue(values.where || 'We will fetch it when it is done')
      .setStyle(TextInputStyle.Paragraph);

    const whenInput = new TextInputBuilder()
      .setCustomId('ticket/form/when')
      .setLabel((emoji.when ? `${emoji.when} ` : '') + 'When do you need it?')
      .setValue(values.when || 'ASAP')
      .setStyle(TextInputStyle.Short);

    return new ModalBuilder()
      .setCustomId(`ticket/create/${channelRef}`)
      .setTitle('Create a Ticket')
      .addComponents(
        [titleInput, whatInput, whereInput, whenInput].map((input) =>
          new ActionRowBuilder<TextInputBuilder>().addComponents(input),
        ),
      );
  }

  @StringSelect('ticket/move/:thread')
  async onTicketMove(
    @Context() [interaction]: StringSelectContext,
    @ComponentParam('thread') threadRef: Snowflake,
    @SelectedStrings() [selected]: string[],
  ) {
    const member = await interaction.guild.members.fetch(interaction.user);
    const guild = await this.guildService.getGuild({ guildSf: interaction.guildId });
    const result = await this.ticketService.moveTicket(
      { threadSf: threadRef },
      { guildId: guild.id, crewSf: selected, updatedBy: member.id },
    );
    return interaction.reply({ content: result.message, ephemeral: true });
  }

  @Modal('ticket/create/:crew')
  async onTicketSubmit(
    @Context() [interaction]: ModalContext,
    @ModalParam('crew') crewRef: Snowflake,
  ) {
    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user);

    const title = interaction.fields.getTextInputValue('ticket/form/title');
    const content = [
      '## What do you need?',
      interaction.fields.getTextInputValue('ticket/form/what'),
      '',
      '## Where is it needed?',
      interaction.fields.getTextInputValue('ticket/form/where'),
      '',
      '## When do you need it by?',
      interaction.fields.getTextInputValue('ticket/form/when'),
      '',
      '',
    ].join('\n');

    const result = await this.ticketService.createTicket(
      { crewSf: crewRef },
      {
        name: title,
        content,
        createdBy: member.id,
      },
    );

    return interaction.reply({ content: result.message, ephemeral: true });
  }

  buildDeclineModal(threadRef: GuildChannelResolvable) {
    const reason = new TextInputBuilder()
      .setCustomId('ticket/decline/reason')
      .setLabel('Reason')
      .setStyle(TextInputStyle.Paragraph);

    return new ModalBuilder()
      .setCustomId(`ticket/decline/${threadRef}`)
      .setTitle('Decline Ticket')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reason));
  }

  @Button('ticket/reqdecline/:thread')
  async onTicketRequestDecline(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('thread') threadRef: Snowflake,
  ) {
    const modal = this.buildDeclineModal(threadRef);
    interaction.showModal(modal);
  }

  @Modal('ticket/decline/:thread')
  async onTicketDecline(
    @Context() [interaction]: ModalContext,
    @ModalParam('thread') threadRef: Snowflake,
  ) {
    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user);
    const reason = interaction.fields.getTextInputValue('ticket/decline/reason');

    const thread = await guild.channels.fetch(threadRef);

    if (!thread.isThread()) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Invalid thread');
    }

    const result = await this.ticketService.updateTicket(
      { threadSf: thread.id, updatedBy: member.id },
      TicketTag.DECLINED,
      reason,
    );

    await this.botService.replyOrFollowUp(interaction, {
      embeds: [new SuccessEmbed('SUCCESS_GENERIC').setTitle('Ticket declined')],
    });
  }

  @Subcommand({
    name: 'move',
    description: 'Show the select prompt send this ticket to another crew',
    dmPermission: false,
  })
  async onTicketMovePrompt(@Context() [interaction]: SlashCommandContext) {
    const ticket = await this.ticketRepo.findOne({
      where: { threadSf: interaction.channelId },
      withDeleted: true,
    });
    if (!ticket) {
      return interaction.reply({
        content: 'This command can only be used in a ticket',
        ephemeral: true,
      });
    }

    const row = await this.ticketService.createMovePrompt(ticket, [{ crewSf: ticket.crew.crewSf }]);

    await this.botService.replyOrFollowUp(interaction, {
      embeds: [new PromptEmbed('PROMPT_GENERIC').setTitle('Select destination')],
      components: [row],
    });
  }

  @Subcommand({
    name: 'triage',
    description: 'Show the triage prompt change the state of the ticket',
    dmPermission: false,
  })
  async onTicketTriagePrompt(@Context() [interaction]: SlashCommandContext) {
    const { channel } = interaction;

    const ticket = await this.ticketRepo.findOneOrFail({
      where: { threadSf: channel.id },
      withDeleted: true,
    });

    const row = await this.ticketService.createTriageControl(ticket);

    await this.botService.replyOrFollowUp(interaction, {
      embeds: [new PromptEmbed('PROMPT_GENERIC').setTitle('Select action')],
      components: [row],
    });
  }

  @Button('ticket/action/:action/:thread')
  async onTicketAction(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('action') action: string,
    @ComponentParam('thread') threadId: Snowflake,
  ) {
    const { guild } = interaction;
    const tag = TicketActionToTag[action];
    const member = await guild.members.fetch(interaction.user.id);
    const thread = await guild.channels.fetch(threadId);

    if (!thread.isThread()) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Invalid ticket');
    }

    if (!tag) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Invalid ticket tag');
    }

    const result = await this.ticketService.updateTicket(
      { threadSf: thread.id, updatedBy: member.id },
      tag,
    );

    await this.botService.replyOrFollowUp(interaction, {
      embeds: [new SuccessEmbed('SUCCESS_GENERIC').setTitle('Ticket updated')],
    });
  }

  async lifecycleCommand([interaction]: SlashCommandContext, tag: TicketTag, reason?: string) {
    const member = await interaction.guild.members.fetch(interaction.user);
    const thread = interaction.channel;

    if (!thread.isThread()) {
      throw new InternalError('INTERNAL_SERVER_ERROR', 'Invalid thread');
    }

    const result = await this.ticketService.updateTicket(
      { threadSf: thread.id, updatedBy: member.id },
      tag,
      reason,
    );

    await this.botService.replyOrFollowUp(interaction, {
      embeds: [new SuccessEmbed('SUCCESS_GENERIC').setTitle('Ticket updated')],
    });
  }

  @Subcommand({
    name: 'accept',
    description: 'Accept a ticket. Team members only',
    dmPermission: false,
  })
  async onTicketAcceptCommand(@Context() context: SlashCommandContext) {
    return this.lifecycleCommand(context, TicketTag.ACCEPTED);
  }

  @Subcommand({
    name: 'decline',
    description: 'Decline a ticket. Team members only',
    dmPermission: false,
  })
  async onTicketDeclineCommand(
    @Context() context: SlashCommandContext,
    @Options() data: TicketDeclineReasonCommandParams,
  ) {
    return this.lifecycleCommand(context, TicketTag.DECLINED, data.reason);
  }

  @Subcommand({
    name: 'abandoned',
    description: 'Mark a ticket as abandoned. Team members only',
    dmPermission: false,
  })
  async onTicketAbandonedCommand(@Context() context: SlashCommandContext) {
    return this.lifecycleCommand(context, TicketTag.ABANDONED);
  }

  @Subcommand({
    name: 'start',
    description: 'Mark a ticket as being in progress. Team members only',
    dmPermission: false,
  })
  async onTicketStartCommand(@Context() context: SlashCommandContext) {
    return this.lifecycleCommand(context, TicketTag.IN_PROGRESS);
  }

  @Subcommand({
    name: 'repeatable',
    description: 'Mark a ticket as repeatable. Team members only',
    dmPermission: false,
  })
  async onTicketRepeatCommand(@Context() context: SlashCommandContext) {
    return this.lifecycleCommand(context, TicketTag.REPEATABLE);
  }

  @Subcommand({
    name: 'done',
    description: 'Complete a ticket. Team members only',
    dmPermission: false,
  })
  async onTicketDoneCommand(@Context() context: SlashCommandContext) {
    return this.lifecycleCommand(context, TicketTag.DONE);
  }

  @UseInterceptors(CrewSelectAutocompleteInterceptor)
  @Subcommand({
    name: 'status',
    description: 'Display the current ticket status for crews',
    dmPermission: false,
  })
  async onCrewStatusRequest(
    @Context() [interaction]: SlashCommandContext,
    @Options() data: SelectCrewCommandParams,
  ) {
    const member = await interaction.guild.members.fetch(interaction.user);

    // Use specified crew
    if (data.crew) {
      const crew = await this.crewRepo.findOneOrFail({ where: { crewSf: data.crew } });
      await this.ticketService.sendIndividualStatus({ crewSf: crew.crewSf }, interaction.channelId);

      // Try infer crew from current channel
    } else {
      const maybeCrew = await this.crewRepo.findOne({
        where: { crewSf: interaction.channelId },
      });
      if (maybeCrew) {
        await this.ticketService.sendIndividualStatus(maybeCrew, interaction.channelId);

        // Send status for all crews
      } else {
        await this.ticketService.sendAllStatus(
          { guildSf: interaction.guildId },
          interaction.channelId,
          member.id,
        );
      }
    }

    await this.botService.replyOrFollowUp(interaction, {
      embeds: [new SuccessEmbed('SUCCESS_GENERIC').setTitle('Status update scheduled')],
    });
  }
}
