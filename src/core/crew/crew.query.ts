import { Brackets, Repository } from 'typeorm';
import { Snowflake } from 'discord.js';
import { CommonQueryBuilder } from 'src/database/util';
import { SelectGuild } from 'src/core/guild/guild.entity';
import { Crew, SelectCrew } from './crew.entity';

const searchWhere = (crewAlias: string = 'crew') => {
  return new Brackets((qb) =>
    qb.where(`${crewAlias}.name ILIKE :query`).orWhere(`${crewAlias}.name_short ILIKE :query`),
  );
};

export class CrewQueryBuilder extends CommonQueryBuilder<Crew> {
  constructor(repo: Repository<Crew>) {
    super(repo, 'crew');
    this.qb.leftJoinAndSelect('crew.guild', 'guild');
  }

  byMember(memberSf: Snowflake | Snowflake[]) {
    if (!Array.isArray(memberSf)) {
      memberSf = [memberSf];
    }

    this.withMembers();
    this.qb.where('member.member_sf IN (:...memberSf)', { memberSf });

    return this;
  }

  byRole(roleSf: Snowflake | Snowflake[]) {
    if (!Array.isArray(roleSf)) {
      roleSf = [roleSf];
    }

    this.qb.where('crew.role_sf IN (:...roleSf)', {
      roleSf,
    });

    return this;
  }

  byCrew(crewRef: SelectCrew | SelectCrew[]) {
    if (!Array.isArray(crewRef)) {
      crewRef = [crewRef];
    }

    this.qb.where('crew.crew_channel_sf IN (:...crews)', {
      crews: crewRef.map((c) => c.crewSf),
    });

    return this;
  }

  byGuild(guildRef: SelectGuild) {
    if (guildRef.id) {
      this.qb.where(new Brackets((qb) => qb.where('crew.guild_id=:id')));
    } else {
      this.qb.where(new Brackets((qb) => qb.where('guild.guild_sf=:guildSf')));
    }

    this.qb.setParameters(guildRef);
    return this;
  }

  byGuildAndShared(guildRef: SelectGuild) {
    this.qb.leftJoin('crew.shared', 'shared').leftJoinAndSelect('shared.crew', 'shared_crew');

    if (guildRef.id) {
      this.qb.where(
        new Brackets((qb) => qb.where('crew.guild_id=:id').orWhere('shared.target_guild_id=:id')),
      );
    } else {
      this.qb
        .leftJoin('shared.guild', 'target_guild')
        .where(
          new Brackets((qb) =>
            qb.where('guild.guild_sf=:guildSf').orWhere('target_guild.guild_sf=:guildSf'),
          ),
        );
    }

    this.qb.setParameters(guildRef);
    return this;
  }

  searchByGuild(guildRef: SelectGuild, query: string) {
    this.byGuild(guildRef);
    this.qb.andWhere(searchWhere(), { query: `%${query}%` });
    return this;
  }

  searchByGuildWithShared(guildRef: SelectGuild, query: string) {
    this.qb
      .leftJoin('crew.shared', 'shared')
      .leftJoinAndSelect('shared.crew', 'shared_crew')
      .setParameters({ ...guildRef, query: `%${query}%` });

    if (guildRef.id) {
      this.qb
        .where(new Brackets((qb) => qb.where('crew.guild_id=:id').andWhere(searchWhere())))
        .orWhere(
          new Brackets((qb) =>
            qb.where('shared.target_guild_id=:id').andWhere(searchWhere('shared_crew')),
          ),
        );
    } else {
      this.qb
        .leftJoin('shared.guild', 'target_guild')
        .where(new Brackets((qb) => qb.where('guild.guild_sf=:guildSf').andWhere(searchWhere())))
        .orWhere(
          new Brackets((qb) =>
            qb.where('target_guild.guild_sf=:guildSf').andWhere(searchWhere('shared_crew')),
          ),
        );
    }

    return this;
  }

  withTeam() {
    this.qb.leftJoinAndSelect('crew.team', 'team');
    return this;
  }

  withMembers() {
    this.qb.leftJoinAndSelect('crew.members', 'member');
    return this;
  }

  withLogs() {
    this.qb.leftJoinAndSelect('crew.logs', 'log');
    return this;
  }

  withTickets() {
    this.qb
      .leftJoinAndSelect('crew.tickets', 'ticket')
      .leftJoinAndSelect('ticket.previous', 'previous');
    return this;
  }

  withShared() {
    this.qb
      .leftJoinAndSelect('crew.shared', 'shared')
      .leftJoinAndSelect('shared.guild', 'shared_guild');
    return this;
  }
}