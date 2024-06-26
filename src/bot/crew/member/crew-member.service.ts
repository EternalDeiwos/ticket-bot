import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { DeepPartial, Equal } from 'typeorm';
import {
  GuildManager,
  GuildMember,
  PermissionsBitField,
  Snowflake,
  roleMention,
  userMention,
} from 'discord.js';
import { ConfigService } from 'src/config';
import { OperationStatus } from 'src/util';
import { Crew } from 'src/bot/crew/crew.entity';
import { CrewService } from 'src/bot/crew/crew.service';
import { CrewRepository } from 'src/bot/crew/crew.repository';
import { CrewMemberRepository } from './crew-member.repository';
import { CrewMember, CrewMemberAccess } from './crew-member.entity';

@Injectable()
export class CrewMemberService {
  private readonly logger = new Logger(CrewMemberService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly guildManager: GuildManager,
    @Inject(forwardRef(() => CrewService)) private readonly crewService: CrewService,
    private readonly crewRepo: CrewRepository,
    private readonly memberRepo: CrewMemberRepository,
  ) {}

  async resolveGuildMember(member: CrewMember): Promise<OperationStatus<GuildMember>>;
  async resolveGuildMember(
    memberRef: Snowflake,
    channelRef: Snowflake,
  ): Promise<OperationStatus<GuildMember>>;
  async resolveGuildMember(
    memberRef: Snowflake | CrewMember,
    channelRef?: Snowflake,
  ): Promise<OperationStatus<GuildMember>> {
    if (typeof memberRef !== 'string' && memberRef instanceof CrewMember) {
      channelRef = memberRef.channel;
      memberRef = memberRef.member;
    }

    const crew = await this.crewRepo.findOne({
      where: { channel: channelRef },
      withDeleted: true,
    });

    if (!crew) {
      return { success: false, message: `Unable to find crew ${channelRef}` };
    }

    const { data: guild, ...guildResult } = await this.crewService.resolveCrewGuild(crew);

    if (!guildResult) {
      return guildResult;
    }

    try {
      const guildMember = await guild.members.fetch(memberRef);
      return new OperationStatus({ success: true, message: 'Done', data: guildMember });
    } catch (err) {
      this.logger.error(`Failed to resolve member ${memberRef} in ${guild.name}`, err.stack);
      return {
        success: false,
        message: `Member ${memberRef} is not a member of ${guild.name}`,
      };
    }
  }

  async isAdmin(member: GuildMember): Promise<OperationStatus<boolean>>;
  async isAdmin(member: CrewMember): Promise<OperationStatus<boolean>>;
  async isAdmin(member: CrewMember | GuildMember): Promise<OperationStatus<boolean>> {
    if (member instanceof CrewMember) {
      const { data: guildMember, ...guildMemberResult } = await this.resolveGuildMember(member);

      if (!guildMemberResult.success) {
        return guildMemberResult;
      }

      member = guildMember;
    }

    return {
      success: true,
      message: 'Done',
      data: member.permissions.has(PermissionsBitField.Flags.Administrator),
    };
  }

  async registerCrewMember(
    crew: Crew,
    memberRef: Snowflake,
    access: CrewMemberAccess = CrewMemberAccess.MEMBER,
  ): Promise<OperationStatus> {
    if (!crew) {
      return { success: false, message: 'Invalid crew' };
    }

    const crewMember = await this.memberRepo.findOne({
      where: { channel: crew.channel, member: memberRef },
    });

    if (crewMember) {
      // If the user would get more privileges then update the existing record instead
      if (access < crewMember.access) {
        return this.updateCrewMember(crewMember, { access });
      }

      // Otherwise prevent an accidental loss of privilege
      return {
        success: false,
        message: `You are already a ${crewMember.access > CrewMemberAccess.MEMBER ? 'subscriber' : 'member'} of ${roleMention(crew.role)}`,
      };
    }

    const { data: member, ...memberResult } = await this.resolveGuildMember(
      memberRef,
      crew.channel,
    );

    if (!memberResult) {
      return {
        success: false,
        message: `User ${userMention(memberRef)} is not a part of the guild`,
      };
    }

    await this.memberRepo.insert({
      member: member.id,
      guild: crew.guild,
      name: member.displayName,
      icon:
        member.avatarURL({ extension: 'png', forceStatic: true }) ??
        member.user.avatarURL({ extension: 'png', forceStatic: true }),
      access,
      channel: crew.channel,
    });

    await member.roles.add(crew.role);

    return OperationStatus.SUCCESS;
  }

  async updateCrewMember(
    crewMember: CrewMember,
    data: DeepPartial<Pick<CrewMember, 'access' | 'name' | 'icon'>>,
  ) {
    const result = await this.memberRepo.update(
      { channel: Equal(crewMember.crew.channel), member: Equal(crewMember.member) },
      data,
    );

    if (result.affected) {
      return OperationStatus.SUCCESS;
    }

    return {
      success: false,
      message: `Failed to update crew member record for ${crewMember.name}`,
    };
  }

  async removeCrewMember(crewMember: CrewMember): Promise<OperationStatus> {
    if (!crewMember || !(crewMember instanceof CrewMember)) {
      return { success: false, message: 'Invalid crew member' };
    }

    const { data: member, ...memberResult } = await this.resolveGuildMember(
      crewMember.member,
      crewMember.channel,
    );

    if (!memberResult) {
      return {
        success: false,
        message: `User ${userMention(crewMember.member)} is not a part of the guild`,
      };
    }

    try {
      await member.roles.remove(crewMember.crew.role);
    } catch (err) {
      if (member.roles.cache.has(crewMember.crew.role)) {
        this.logger.error(
          `Failed to remove crew role for ${crewMember.crew.name} from ${crewMember.name}: ${err.message}`,
          err.stack,
        );
        return { success: false, message: 'Failed to remove member role' };
      }
    }

    await this.memberRepo.delete({ member: crewMember.member, channel: crewMember.channel });

    return OperationStatus.SUCCESS;
  }
}
