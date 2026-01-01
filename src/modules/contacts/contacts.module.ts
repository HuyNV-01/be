import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';
import { UserModule } from '../user/user.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContactEntity } from 'src/entity/contact.entity';
import { UserEntity } from 'src/entity/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ContactEntity, UserEntity]), UserModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
