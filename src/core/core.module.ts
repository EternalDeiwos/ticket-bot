import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from 'src/bot/bot.module';
import { RMQModule } from 'src/rmq/rmq.module';
import { Team } from './team/team.entity';
import { Crew } from './crew/crew.entity';
import { CrewMember } from './crew/member/crew-member.entity';
import { ForumTag } from './tag/tag.entity';
import { ForumTagTemplate } from './tag/tag-template.entity';
import { Ticket } from './ticket/ticket.entity';
import { CrewLog } from './crew/log/crew-log.entity';
import { Guild } from './guild/guild.entity';
import { CrewShare } from './crew/share/crew-share.entity';
import { BotEventListener } from './bot.listener';
import { TeamService, TeamServiceImpl } from './team/team.service';
import { TeamCommand } from './team/team.command';
import { TeamRepository } from './team/team.repository';
import { CrewService, CrewServiceImpl } from './crew/crew.service';
import { CrewCommand } from './crew/crew.command';
import { CrewRepository } from './crew/crew.repository';
import { CrewMemberService, CrewMemberServiceImpl } from './crew/member/crew-member.service';
import { CrewMemberRepository } from './crew/member/crew-member.repository';
import { CrewLogService, CrewLogServiceImpl } from './crew/log/crew-log.service';
import { CrewLogRepository } from './crew/log/crew-log.repository';
import { CrewShareService, CrewShareServiceImpl } from './crew/share/crew-share.service';
import { CrewShareRepository } from './crew/share/crew-share.repository';
import { TagService, TagServiceImpl } from './tag/tag.service';
import { TagCommand } from './tag/tag.command';
import { TagRepository } from './tag/tag.repository';
import { TagTemplateRepository } from './tag/tag-template.repository';
import { TicketService, TicketServiceImpl } from './ticket/ticket.service';
import { TicketCommand } from './ticket/ticket.command';
import { TicketRepository } from './ticket/ticket.repository';
import { GuildService, GuildServiceImpl } from './guild/guild.service';
import { GuildCommand } from './guild/guild.command';
import { GuildRepository } from './guild/guild.repository';

@Module({
  imports: [
    RMQModule,
    BotModule,
    TypeOrmModule.forFeature([
      Team,
      Crew,
      CrewMember,
      ForumTag,
      ForumTagTemplate,
      Ticket,
      CrewLog,
      Guild,
      CrewShare,
    ]),
  ],
  providers: [
    BotEventListener,
    GuildRepository,
    GuildCommand,
    TeamCommand,
    TeamRepository,
    CrewRepository,
    CrewCommand,
    CrewMemberRepository,
    CrewLogRepository,
    CrewShareRepository,
    TagCommand,
    TagRepository,
    TagTemplateRepository,
    TicketCommand,
    TicketRepository,
    { provide: GuildService, useClass: GuildServiceImpl },
    { provide: TeamService, useClass: TeamServiceImpl },
    { provide: CrewService, useClass: CrewServiceImpl },
    { provide: CrewMemberService, useClass: CrewMemberServiceImpl },
    { provide: CrewLogService, useClass: CrewLogServiceImpl },
    { provide: CrewShareService, useClass: CrewShareServiceImpl },
    { provide: TagService, useClass: TagServiceImpl },
    { provide: TicketService, useClass: TicketServiceImpl },
  ],
  exports: [
    TypeOrmModule,
    GuildService,
    TeamService,
    CrewService,
    CrewMemberService,
    CrewLogService,
    CrewShareService,
    TagService,
    TicketService,
  ],
})
export class CoreModule {}
