import {
  Entity,
  Column,
  DeleteDateColumn,
  Index,
  CreateDateColumn,
  RelationId,
  ManyToOne,
  JoinColumn,
  PrimaryColumn,
  UpdateDateColumn,
  DeepPartial,
} from 'typeorm';
import { Snowflake } from 'discord.js';
import { Expose, Transform } from 'class-transformer';
import { Guild } from 'src/core/guild/guild.entity';
import { Crew } from 'src/core/crew/crew.entity';

export type InsertTicket = DeepPartial<
  Omit<Ticket, 'crew' | 'previous' | 'guild' | 'updatedAt' | 'createdAt' | 'deletedAt'>
>;
export type SelectTicket = DeepPartial<Pick<Ticket, 'threadSf'>>;

@Entity()
export class Ticket {
  @Expose()
  @PrimaryColumn({ type: 'int8', name: 'thread_sf', primaryKeyConstraintName: 'pk_thread_sf' })
  threadSf: Snowflake;

  @Column({ type: 'uuid', name: 'guild_id' })
  @Index('guild_id_idx_ticket')
  guildId: string;

  @ManyToOne(() => Guild, { onDelete: 'CASCADE', eager: true })
  @Expose()
  @Transform(({ value }) => (value ? value : null))
  @JoinColumn({
    name: 'guild_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_ticket_guild_id',
  })
  guild: Guild;

  @Expose()
  @Column({ type: 'int8', name: 'previous_thread_sf', nullable: true })
  @RelationId((ticket: Ticket) => ticket.previous)
  @Index('previous_thread_sf_idx_ticket')
  previousThreadSf: Snowflake;

  @ManyToOne(() => Ticket, { onDelete: 'RESTRICT', nullable: true })
  @Expose()
  @Transform(({ value }) => (value && 'threadSf' in value ? value : null))
  @JoinColumn({
    name: 'previous_thread_sf',
    referencedColumnName: 'threadSf',
    foreignKeyConstraintName: 'fk_ticket_previous_thread_sf',
  })
  previous: Ticket;

  /**
   * Snowflake for crew Discord channel
   * @type Snowflake
   */
  @Column({ type: 'int8', name: 'crew_channel_sf' })
  @Expose()
  @RelationId((ticket: Ticket) => ticket.crew)
  @Index('crew_channel_sf_idx_ticket')
  crewSf: Snowflake;

  @ManyToOne(() => Crew, (crew) => crew.tags, { onDelete: 'CASCADE', eager: true })
  @Expose()
  @Transform(({ value }) => (value ? value : null))
  @JoinColumn({
    name: 'crew_channel_sf',
    referencedColumnName: 'crewSf',
    foreignKeyConstraintName: 'fk_ticket_crew_channel_sf',
  })
  crew: Crew;

  @Expose()
  @Column({ name: 'content', type: 'text' })
  content: string;

  @Expose()
  @Column()
  name: string;

  @Expose()
  @Column({ name: 'sort_order', default: '' })
  @Index('sort_order_idx_ticket')
  sortOrder: string;

  @Expose()
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @Expose()
  @Column({ type: 'int8', name: 'updated_by_sf' })
  updatedBy: Snowflake;

  @Expose()
  @Column({ type: 'int8', name: 'created_by_sf' })
  createdBy: Snowflake;

  @Expose()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Expose()
  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at' })
  deletedAt: Date;
}
