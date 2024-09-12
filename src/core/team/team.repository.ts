import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommonRepository } from 'src/database/util';
import { Snowflake } from 'discord.js';
import { Team } from './team.entity';

@Injectable()
export class TeamRepository extends CommonRepository<Team> {
  constructor(private readonly dataSource: DataSource) {
    super(Team, dataSource.createEntityManager());
  }

  search(guildId: Snowflake, query: string) {
    return this.createQueryBuilder('team')
      .leftJoin('team.guild', 'guild')
      .where(`guild.guild_sf = :guild AND team.name ILIKE :query`, {
        guild: guildId,
        query: `%${query}%`,
      });
  }
}
